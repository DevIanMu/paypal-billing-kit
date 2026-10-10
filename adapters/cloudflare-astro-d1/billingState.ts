import { monthlyCreditsLeft, isSubscriptionActive, type SubscriptionRow } from '../../src/core/entitlement';
import type { BillingCatalog } from '../../src/core/catalog';

export interface BillingState {
  subscription: SubscriptionRow | null;
  packLeft: number;
  monthlyUsed: number;
  monthlyLimit: number; // 0 when no active subscription
}

/** KV key contract for monthly usage: integer count under `musage:{userId}:{yyyy-mm}`. */
export function monthKey(userId: string, now: Date = new Date()): string {
  return `musage:${userId}:${now.toISOString().slice(0, 7)}`;
}

export async function getBillingState(
  catalog: BillingCatalog,
  db: D1Database,
  quota: KVNamespace,
  userId: string,
  now: Date = new Date(),
): Promise<BillingState> {
  const nowIso = now.toISOString();
  // in-grace cancelled rows still entitle until current_period_end
  const sub = await db.prepare(
    "SELECT plan, cycle, status, current_period_end FROM subscriptions WHERE user_id = ?1 AND (status = 'active' OR (status = 'cancelled' AND current_period_end > ?2)) ORDER BY created_at DESC LIMIT 1",
  ).bind(userId, nowIso).first<SubscriptionRow>();
  const pack = await db.prepare('SELECT total, used FROM credit_packs WHERE user_id = ?1')
    .bind(userId).first<{ total: number; used: number }>();
  const packLeft = pack ? Math.max(0, pack.total - pack.used) : 0;
  if (!sub || !isSubscriptionActive(sub, nowIso)) {
    return { subscription: null, packLeft, monthlyUsed: 0, monthlyLimit: 0 };
  }
  const monthlyUsed = Number((await quota.get(monthKey(userId, now))) ?? 0);
  const plan = catalog.plans.find((p) => p.key === sub.plan);
  return {
    subscription: sub,
    packLeft,
    monthlyUsed,
    monthlyLimit: plan?.monthlyLimit ?? 0,
  };
}

export { monthlyCreditsLeft, isSubscriptionActive };
export type { SubscriptionRow };
