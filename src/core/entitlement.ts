/**
 * Entitlement resolution (credit model). Reference implementation — the
 * free → monthly → pack deduction order is one product's business model.
 * Adapt freely for feature-gate or seat-based billing.
 */

import type { BillingCatalog, EntitlementKind } from './catalog';

export interface SubscriptionRow {
  plan: string;
  cycle?: string;
  status: string;
  current_period_end: string | null;
}

export type Entitlement =
  | { kind: 'monthly'; plan: string; left: number }
  | { kind: 'free'; left: number }
  | { kind: 'pack'; left: number }
  | { kind: 'none' };

export function isSubscriptionActive(sub: SubscriptionRow, nowIso: string): boolean {
  // cancelled keeps access until current_period_end ("cancels on {date}" UX),
  // then falls back to free/pack; suspended/expired never count
  if (sub.status === 'cancelled') {
    return !!sub.current_period_end && sub.current_period_end > nowIso;
  }
  if (sub.status !== 'active') return false;
  if (sub.current_period_end && sub.current_period_end <= nowIso) return false;
  return true;
}

export function monthlyCreditsLeft(catalog: BillingCatalog, used: number, plan: string): number {
  const limit = catalog.plans.find((p) => p.key === plan)?.monthlyLimit ?? 0;
  return Math.max(0, limit - used);
}

export function resolveEntitlement(args: {
  catalog: BillingCatalog;
  subscription: SubscriptionRow | null;
  monthlyUsed: number;
  freeLeft: number;
  packLeft: number;
  nowIso: string;
}): Entitlement {
  const { catalog, subscription, monthlyUsed, freeLeft, packLeft, nowIso } = args;
  const candidates: Record<EntitlementKind, () => Entitlement | null> = {
    monthly: () => {
      if (!subscription || !isSubscriptionActive(subscription, nowIso)) return null;
      const left = monthlyCreditsLeft(catalog, monthlyUsed, subscription.plan);
      return left > 0 ? { kind: 'monthly', plan: subscription.plan, left } : null;
    },
    free: () => (freeLeft > 0 ? { kind: 'free', left: freeLeft } : null),
    pack: () => (packLeft > 0 ? { kind: 'pack', left: packLeft } : null),
  };
  const order: EntitlementKind[] = catalog.entitlement?.order ?? ['monthly', 'free', 'pack'];
  for (const kind of order) {
    const hit = candidates[kind]();
    if (hit) return hit;
  }
  return { kind: 'none' };
}
