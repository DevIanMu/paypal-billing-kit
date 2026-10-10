import type { BillingDeps } from '../types';
import { json } from '../types';

/**
 * POST /api/billing/cancel — two-click self-serve cancel.
 * Entitlement keeps running until current_period_end (grace period).
 */
export async function handleCancel(deps: BillingDeps, request: Request): Promise<Response> {
  if (!deps.paymentsEnabled) return json({ error: 'payments_disabled' }, 503);
  const userId = await deps.getUserId(request);
  if (!userId) return json({ error: 'auth_required' }, 401);

  const sub = await deps.db.prepare(
    "SELECT id, provider_sub_id, current_period_end FROM subscriptions WHERE user_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  ).bind(userId).first<{ id: string; provider_sub_id: string; current_period_end: string | null }>();
  if (!sub) return json({ error: 'no_active_subscription' }, 404);

  try {
    await deps.paypal.cancelSubscription(sub.provider_sub_id);
  } catch (err) {
    console.error('paypal cancel failed:', err);
    return json({ error: 'cancel_failed' }, 502);
  }

  await deps.db.prepare(
    "UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?1",
  ).bind(sub.id).run();
  await deps.db.prepare(
    "UPDATE users SET subscription_status = 'cancelled', updated_at = datetime('now') WHERE id = ?1",
  ).bind(userId).run();

  const accessUntil = sub.current_period_end ?? new Date().toISOString();
  if (deps.notify) {
    const user = await deps.db.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string }>();
    if (user?.email) {
      try {
        await deps.notify({ type: 'cancelled', email: user.email, accessUntil });
      } catch (err) { console.error('cancel notification failed:', err); }
    }
  }
  return json({ ok: true, accessUntil });
}
