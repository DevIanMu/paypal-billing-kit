import type { BillingDeps } from '../types';
import { json } from '../types';
import {
  subscriptionKinds, packKeys, parseSubKind, planIdFor, isDowngrade, orderAmountStr, findPack,
} from '../../../src/core/catalog';
import { generateToken } from '../auth';

type Deps = BillingDeps;

/**
 * POST /api/billing/checkout — body { kind }.
 * Transition guard semantics (battle-tested):
 *   - same plan/cycle          → 409 subscription_active
 *   - downgrade                → cancel now, keep access until period end, schedule switch_target
 *   - upgrade                  → cancel old FIRST (no double-billing window), buy immediately
 *   - in-grace cancelled + new kind:
 *       same as switch_target  → idempotent 200 { scheduled }
 *       cheaper                → re-target the scheduled downgrade
 *       pricier                → abandon scheduled switch, buy now
 *   - packs always fall through (they stack, never touch subscriptions)
 */
export async function handleCheckout(deps: Deps, request: Request): Promise<Response> {
  if (!deps.paymentsEnabled) return json({ error: 'payments_disabled' }, 503);
  const userId = await deps.getUserId(request);
  if (!userId) return json({ error: 'auth_required' }, 401);

  let body: { kind?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const validKinds = [...subscriptionKinds(deps.catalog), ...packKeys(deps.catalog)];
  const kind = typeof body.kind === 'string' && validKinds.includes(body.kind) ? body.kind : null;
  if (!kind) return json({ error: 'kind_invalid' }, 400);

  const isPack = !!findPack(deps.catalog, kind);

  // transition guard: an in-grace cancelled sub with a pending switch means a
  // downgrade is already scheduled — never create a new subscription on top of it
  if (!isPack) {
    const pending = await deps.db.prepare(
      "SELECT id, plan, cycle, switch_target, current_period_end FROM subscriptions WHERE user_id = ?1 AND status = 'cancelled' AND switch_target IS NOT NULL LIMIT 1",
    ).bind(userId).first<{ id: string; plan: string; cycle: string; switch_target: string; current_period_end: string | null }>();
    if (pending) {
      if (kind === pending.switch_target) {
        return json({ scheduled: true, accessUntil: pending.current_period_end }, 200); // idempotent re-click
      }
      const graceKind = `${pending.plan}_${pending.cycle}`;
      if (isDowngrade(deps.catalog, graceKind, kind)) {
        // re-target the scheduled downgrade to the newly requested cheaper plan
        await deps.db.prepare(
          "UPDATE subscriptions SET switch_target = ?1, updated_at = datetime('now') WHERE id = ?2",
        ).bind(kind, pending.id).run();
        return json({ scheduled: true, accessUntil: pending.current_period_end }, 200);
      }
      // upgrade over a pending downgrade: abandon the scheduled switch and buy now
      await deps.db.prepare(
        "UPDATE subscriptions SET switch_target = NULL, updated_at = datetime('now') WHERE id = ?1",
      ).bind(pending.id).run();
      // fall through to the normal checkout flow (no active sub exists -> creates the new one)
    }
  }

  // block duplicates; a DIFFERENT plan/cycle is a switch — cancel the old sub first
  if (!isPack) {
    const existing = await deps.db.prepare(
      "SELECT id, provider_sub_id, plan, cycle, current_period_end FROM subscriptions WHERE user_id = ?1 AND status = 'active' LIMIT 1",
    ).bind(userId).first<{ id: string; provider_sub_id: string; plan: string; cycle: string; current_period_end: string | null }>();
    if (existing) {
      const want = parseSubKind(kind)!;
      if (existing.plan === want.plan && existing.cycle === want.cycle) {
        return json({ error: 'subscription_active' }, 409);
      }
      const existingKind = `${existing.plan}_${existing.cycle}`;
      if (isDowngrade(deps.catalog, existingKind, kind)) {
        // Downgrade: cancel now, keep current plan until period end, and notify
        // the user at period end to complete the cheaper subscription. Charging
        // the new cheap plan immediately would double-charge (the remainder of
        // the current paid period is forfeited).
        try {
          await deps.paypal.cancelSubscription(existing.provider_sub_id);
        } catch (err) {
          console.error('plan downgrade: cancel old subscription failed:', err);
          return json({ error: 'switch_failed' }, 502);
        }
        await deps.db.prepare(
          "UPDATE subscriptions SET status = 'cancelled', switch_target = ?1, updated_at = datetime('now') WHERE id = ?2",
        ).bind(kind, existing.id).run();
        return json({ scheduled: true, accessUntil: existing.current_period_end ?? null });
      }
      // upgrade. Cancel old BEFORE creating the new one so there is never a
      // window where both PayPal agreements are active (double-billing). The old
      // row keeps status='cancelled' with a future current_period_end, so grace
      // access until period end is preserved by existing entitlement semantics.
      // A failed cancel aborts checkout entirely — creating the new sub anyway
      // would leave the user paying for both.
      try {
        await deps.paypal.cancelSubscription(existing.provider_sub_id);
      } catch (err) {
        console.error('plan switch: cancel old subscription failed:', err);
        return json({ error: 'switch_failed' }, 502);
      }
      await deps.db.prepare(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?1",
      ).bind(existing.id).run();
    }
  }

  const origin = deps.publicOrigin || new URL(request.url).origin;
  const successPath = deps.successPath ?? '/billing/success';
  const cancelPath = deps.cancelPath ?? '/billing/cancel';
  const orderId = generateToken(8); // 16 hex chars

  try {
    if (isPack) {
      const pack = findPack(deps.catalog, kind)!;
      const { id, approvalUrl } = await deps.paypal.createOrder({
        amount: pack.price.toFixed(2),
        currency: deps.catalog.currency,
        description: pack.description,
        returnUrl: `${origin}${successPath}`,
        cancelUrl: `${origin}${cancelPath}`,
      });
      if (!approvalUrl) return json({ error: 'checkout_failed' }, 502);
      await deps.db.prepare(
        `INSERT INTO orders (id, user_id, kind, provider_order_id, amount, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'created')`,
      ).bind(orderId, userId, kind, id, pack.price.toFixed(2)).run();
      return json({ approvalUrl });
    }
    const planId = planIdFor(deps.catalog, kind, deps.envMap ?? {});
    if (!planId) return json({ error: 'plan_not_configured' }, 500);
    const plan = parseSubKind(kind)!.plan; // subscription kinds only here (pack returned above)
    const { id, approvalUrl } = await deps.paypal.createSubscription(
      planId, `${origin}${successPath}?plan=${plan}`, `${origin}${cancelPath}`, userId,
    );
    if (!approvalUrl) return json({ error: 'checkout_failed' }, 502);
    await deps.db.prepare(
      `INSERT INTO orders (id, user_id, kind, provider_order_id, amount, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'created')`,
    ).bind(orderId, userId, kind, id, orderAmountStr(deps.catalog, kind)).run();
    return json({ approvalUrl });
  } catch (err) {
    console.error('checkout failed:', err);
    return json({ error: 'checkout_failed' }, 502);
  }
}
