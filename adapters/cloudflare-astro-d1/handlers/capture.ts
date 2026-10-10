import type { BillingDeps } from '../types';
import { json } from '../types';
import { captureAmountOk, findPack } from '../../../src/core/catalog';

/**
 * POST /api/billing/capture — body { orderId }. Return-url capture path for
 * one-time packs. Idempotent: a completed order reports the balance only.
 * Races with the webhook are settled by the conditional status='created'
 * claim; PayPal 422 ORDER_ALREADY_CAPTURED maps to the balance path.
 */
export async function handleCapture(deps: BillingDeps, request: Request): Promise<Response> {
  if (!deps.paymentsEnabled) return json({ error: 'payments_disabled' }, 503);
  const userId = await deps.getUserId(request);
  if (!userId) return json({ error: 'auth_required' }, 401);

  let body: { orderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.orderId !== 'string' || body.orderId.length < 6) {
    return json({ error: 'order_id_invalid' }, 400);
  }

  const order = await deps.db.prepare(
    'SELECT id, user_id, kind, status FROM orders WHERE provider_order_id = ?1 AND kind IN (SELECT value FROM json_each(?2))',
  ).bind(body.orderId, JSON.stringify(deps.catalog.packs.map((p) => p.key)))
    .first<{ id: string; user_id: string; kind: string; status: string }>();
  if (!order || order.user_id !== userId) return json({ error: 'order_unknown' }, 404);

  const packLeftOf = async (): Promise<number> => {
    const pack = await deps.db.prepare('SELECT total, used FROM credit_packs WHERE user_id = ?1')
      .bind(userId).first<{ total: number; used: number }>();
    return pack ? pack.total - pack.used : 0;
  };

  if (order.status !== 'created') {
    // webhook or an earlier call already finalized this order — report balance only
    return json({ ok: true, packCreditsLeft: await packLeftOf(), already: true });
  }

  // capture at PayPal first, amount check against the catalog, then claim the
  // order row so the webhook can't double-credit
  try {
    const { status, value } = await deps.paypal.captureOrder(body.orderId);
    if (status !== 'COMPLETED' || !value || !captureAmountOk(deps.catalog, order.kind, value)) {
      console.error('capture mismatch:', status, value);
      return json({ error: 'capture_failed' }, 502);
    }
  } catch (err) {
    // PayPal answers 422 ORDER_ALREADY_CAPTURED when a racing request captured first —
    // if that request also claimed the order, report the balance instead of a failure
    if (err instanceof Error && err.message.includes('422')) {
      try {
        const recheck = await deps.db.prepare('SELECT status FROM orders WHERE id = ?1')
          .bind(order.id).first<{ status: string }>();
        if (recheck?.status === 'completed') {
          return json({ ok: true, packCreditsLeft: await packLeftOf(), already: true });
        }
      } catch (dbErr) {
        console.error('capture recheck failed:', dbErr);
      }
    }
    console.error('capture error:', err);
    return json({ error: 'capture_failed' }, 502);
  }

  try {
    const won = await deps.db.prepare(
      "UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?1 AND status = 'created'",
    ).bind(order.id).run();
    if (won.meta.changes === 0) {
      // webhook won the race while we were capturing at PayPal — it already credited
      return json({ ok: true, packCreditsLeft: await packLeftOf(), already: true });
    }

    const credits = findPack(deps.catalog, order.kind)?.credits ?? 0;
    await deps.db.prepare(
      `INSERT INTO credit_packs (user_id, total, used) VALUES (?1, ?2, 0)
       ON CONFLICT(user_id) DO UPDATE SET total = total + ?2, updated_at = datetime('now')`,
    ).bind(userId, credits).run();

    return json({ ok: true, packCreditsLeft: await packLeftOf() });
  } catch (err) {
    // the payment was captured but the D1 writes didn't all land — refund/repair is manual
    console.error('capture credit failed:', err);
    return json({ error: 'capture_failed' }, 502);
  }
}
