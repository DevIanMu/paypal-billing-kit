import type { BillingDeps } from '../types';
import { eventToAction, statusFromEvent } from '../../../src/core/events';
import { kindOfPlanId, orderAmountStr, findPack, parseSubKind } from '../../../src/core/catalog';

/**
 * POST /api/billing/webhook — PayPal-signed event sink.
 *
 * Hard-won semantics preserved from production:
 *   - signature verified via PayPal verify-webhook-signature (fail closed)
 *   - atomic claim INSERT OR IGNORE → duplicate deliveries short-circuit
 *   - action failure releases the claim + 500 so PayPal retries
 *   - ACTIVATED heals a missing orders row via custom_id + plan_id reverse lookup
 *   - PAYMENT.CAPTURE.COMPLETED with no matching pack order = subscription
 *     renewal → re-sync current_period_end (month 2+ would otherwise lose access)
 *   - pack crediting is claimed with conditional UPDATE ... WHERE status='created'
 *     so return-url capture and webhook can't double-credit
 */
export async function handleWebhook(deps: BillingDeps, request: Request): Promise<Response> {
  if (!deps.paymentsEnabled) return new Response('payments_disabled', { status: 503 }); // no PayPal calls
  const rawBody = await request.text();

  let ok = false;
  try {
    ok = await deps.paypal.verifyWebhook(request.headers, rawBody);
  } catch (err) {
    // transport/parse failure — 500 so PayPal retries
    console.error('webhook verify error:', err);
    return new Response('verify error', { status: 500 });
  }
  if (!ok) return new Response('invalid', { status: 401 });

  const event = JSON.parse(rawBody) as {
    id: string;
    event_type: string;
    resource?: {
      id?: string;
      custom_id?: string;
      billing_agreement_id?: string;
      supplementary_data?: { related_ids?: { order_id?: string } };
    };
  };

  // idempotency: claim the event atomically; duplicate deliveries short-circuit
  const claim = await deps.db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?1, ?2)')
    .bind(event.id, event.event_type).run();
  if (claim.meta.changes === 0) return new Response('ok', { status: 200 }); // duplicate delivery

  const action = eventToAction(event.event_type);

  try {
    if (action === 'activate') {
      const subId = event.resource?.id ?? '';
      const order = await deps.db.prepare(
        `SELECT id, user_id, kind FROM orders WHERE provider_order_id = ?1
         AND kind NOT IN (SELECT value FROM json_each(?2))`,
      ).bind(subId, JSON.stringify(deps.catalog.packs.map((p) => p.key)))
        .first<{ id: string; user_id: string; kind: string }>();

      // fetch subscription detail from PayPal: period end for everyone, plan_id for the heal path
      const detail = await deps.paypal.getSubscriptionDetail(subId);
      const periodEnd = detail?.billing_info?.next_billing_time ?? null; // raw PayPal ISO-8601 — entitlement compares as ISO strings

      let userId: string;
      let kind: string;
      if (order) {
        userId = order.user_id;
        kind = order.kind;
      } else {
        // heal path: orders row missing (e.g. D1 down during checkout) —
        // custom_id carries userId; kind derived from PayPal's plan_id
        const customId = event.resource?.custom_id;
        if (!customId || !detail?.plan_id) {
          console.error('webhook activate: unknown subscription', subId);
          return new Response('ok', { status: 200 });
        }
        const healed = kindOfPlanId(deps.catalog, deps.envMap ?? {}, detail.plan_id);
        if (!healed) {
          console.error('webhook activate: unmapped plan_id', detail.plan_id);
          return new Response('ok', { status: 200 });
        }
        kind = healed;
        userId = customId;
      }

      const parsed = parseSubKind(kind)!;
      await deps.db.prepare(
        `INSERT INTO subscriptions (id, user_id, provider_sub_id, plan, cycle, status, current_period_end)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)
         ON CONFLICT(provider_sub_id) DO UPDATE SET
           status = 'active', current_period_end = excluded.current_period_end,
           updated_at = datetime('now')`,
      ).bind(crypto.randomUUID(), userId, subId, parsed.plan, parsed.cycle, periodEnd).run();
      if (order) {
        await deps.db.prepare(
          "UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?1",
        ).bind(order.id).run();
      } else {
        // heal path: backfill the orders row so future lookups succeed
        await deps.db.prepare(
          `INSERT INTO orders (id, user_id, kind, provider_order_id, amount, status)
           VALUES (?1, ?2, ?3, ?4, ?5, 'completed')`,
        ).bind(crypto.randomUUID(), userId, kind, subId, orderAmountStr(deps.catalog, kind)).run();
      }
      await deps.db.prepare(
        "UPDATE users SET plan = ?1, subscription_status = 'active', updated_at = datetime('now') WHERE id = ?2",
      ).bind(parsed.plan, userId).run();
      if (deps.notify) {
        const user = await deps.db.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string }>();
        if (user?.email) {
          try {
            await deps.notify({
              type: 'payment_success', email: user.email,
              plan: parsed.plan, cycle: parsed.cycle, periodEnd,
            });
          } catch (err) { console.error('activation notification failed:', err); }
        }
      }
    }

    if (action === 'deactivate') {
      const subId = event.resource?.id ?? '';
      const status = statusFromEvent(event.event_type);
      await deps.db.prepare(
        "UPDATE subscriptions SET status = ?1, updated_at = datetime('now') WHERE provider_sub_id = ?2",
      ).bind(status, subId).run();
      await deps.db.prepare(
        `UPDATE users SET subscription_status = ?1, updated_at = datetime('now')
         WHERE id = (SELECT user_id FROM subscriptions WHERE provider_sub_id = ?2)`,
      ).bind(status, subId).run();
    }

    if (action === 'pack_paid') {
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id ?? '';
      const order = await deps.db.prepare(
        `SELECT id, user_id, kind, status FROM orders WHERE provider_order_id = ?1
         AND kind IN (SELECT value FROM json_each(?2))`,
      ).bind(orderId, JSON.stringify(deps.catalog.packs.map((p) => p.key)))
        .first<{ id: string; user_id: string; kind: string; status: string }>();
      if (!order) {
        // subscription renewal path: PAYMENT.CAPTURE.COMPLETED also fires for sub
        // renewals (no second ACTIVATED arrives), so an unmatched capture here means
        // a renewal payment — re-sync the period end or access dies in month 2.
        const subIdRenew = event.resource?.billing_agreement_id ?? '';
        if (subIdRenew) {
          const detail = await deps.paypal.getSubscriptionDetail(subIdRenew);
          const nextEnd = detail?.billing_info?.next_billing_time ?? null;
          await deps.db.prepare(
            "UPDATE subscriptions SET current_period_end = ?1, status = 'active', reminded_period = NULL, updated_at = datetime('now') WHERE provider_sub_id = ?2",
          ).bind(nextEnd, subIdRenew).run();
          return new Response('ok', { status: 200 }); // nextEnd null still fine: next cycle re-syncs
        }
        return new Response('ok', { status: 200 });
      }
      // Claim the order before crediting so the capture endpoint and this webhook
      // can't both award the pack. Residual window: a crash between the claim
      // UPDATE and the credit INSERT below leaves the order completed without
      // credits — support remedies manually; single-statement failures only.
      const won = await deps.db.prepare(
        "UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?1 AND status = 'created'",
      ).bind(order.id).run();
      if (won.meta.changes === 0) return new Response('ok', { status: 200 }); // capture endpoint or a retry already handled it
      const credits = findPack(deps.catalog, order.kind)?.credits ?? 0;
      await deps.db.prepare(
        `INSERT INTO credit_packs (user_id, total, used) VALUES (?1, ?2, 0)
         ON CONFLICT(user_id) DO UPDATE SET total = total + ?2, updated_at = datetime('now')`,
      ).bind(order.user_id, credits).run();
      if (deps.notify) {
        const user = await deps.db.prepare('SELECT email FROM users WHERE id = ?1').bind(order.user_id).first<{ email: string }>();
        if (user?.email) {
          try {
            await deps.notify({ type: 'pack_paid', email: user.email, packKey: order.kind });
          } catch (err) { console.error('pack notification failed:', err); }
        }
      }
    }
  } catch (err) {
    console.error('webhook action failed:', event.event_type, err);
    await deps.db.prepare('DELETE FROM webhook_events WHERE event_id = ?1').bind(event.id).run();
    return new Response('action error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
