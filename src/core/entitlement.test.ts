import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveEntitlement, isSubscriptionActive, monthlyCreditsLeft } from './entitlement';
import type { BillingCatalog } from './catalog';

const NOW = '2026-09-30T12:00:00.000Z';

const catalog: BillingCatalog = {
  currency: 'USD',
  plans: [
    { key: 'starter', label: 'Starter', monthlyLimit: 500, monthly: { price: 6, planIdEnv: 'A' } },
    { key: 'pro', label: 'Pro', monthlyLimit: 2000, monthly: { price: 15, planIdEnv: 'B' } },
  ],
  packs: [{ key: 'pack', label: '100 credits', price: 9, credits: 100, description: 'credits' }],
};

describe('isSubscriptionActive', () => {
  it('active without period end counts', () => {
    expect(isSubscriptionActive({ plan: 'starter', status: 'active', current_period_end: null }, NOW)).toBe(true);
  });
  it('active with future period end counts', () => {
    expect(isSubscriptionActive({ plan: 'pro', status: 'active', current_period_end: '2026-10-30T00:00:00Z' }, NOW)).toBe(true);
  });
  it('active but period end passed does not count', () => {
    expect(isSubscriptionActive({ plan: 'pro', status: 'active', current_period_end: '2026-09-01T00:00:00Z' }, NOW)).toBe(false);
  });
  it('suspended/expired never count', () => {
    for (const status of ['suspended', 'expired']) {
      expect(isSubscriptionActive({ plan: 'pro', status, current_period_end: '2999-01-01T00:00:00Z' }, NOW)).toBe(false);
    }
  });
  it('cancelled with future period end keeps access until period end', () => {
    expect(isSubscriptionActive({ plan: 'pro', status: 'cancelled', current_period_end: '2026-10-30T00:00:00Z' }, NOW)).toBe(true);
  });
  it('cancelled with past period end does not count', () => {
    expect(isSubscriptionActive({ plan: 'pro', status: 'cancelled', current_period_end: '2026-09-01T00:00:00Z' }, NOW)).toBe(false);
  });
});

describe('monthlyCreditsLeft', () => {
  it('uses catalog monthlyLimit', () => {
    expect(monthlyCreditsLeft(catalog, 100, 'pro')).toBe(1900);
    expect(monthlyCreditsLeft(catalog, 500, 'starter')).toBe(0);
    expect(monthlyCreditsLeft(catalog, 999, 'unknown')).toBe(0);
  });
});

describe('resolveEntitlement', () => {
  const base = { catalog, monthlyUsed: 0, freeLeft: 0, packLeft: 0, nowIso: NOW };

  it('active subscription with monthly left wins', () => {
    const e = resolveEntitlement({
      ...base, subscription: { plan: 'pro', status: 'active', current_period_end: null }, monthlyUsed: 100,
    });
    expect(e).toEqual({ kind: 'monthly', plan: 'pro', left: 1900 });
  });

  it('monthly exhausted falls through to free pool', () => {
    const e = resolveEntitlement({
      ...base, subscription: { plan: 'starter', status: 'active', current_period_end: null },
      monthlyUsed: 500, freeLeft: 2,
    });
    expect(e).toEqual({ kind: 'free', left: 2 });
  });

  it('active subscription with monthly left beats a non-empty free pool', () => {
    const e = resolveEntitlement({
      subscription: { plan: 'starter', status: 'active', current_period_end: null },
      monthlyUsed: 10, freeLeft: 3, packLeft: 5, nowIso: NOW, catalog,
    });
    expect(e).toEqual({ kind: 'monthly', plan: 'starter', left: 490 });
  });

  it('no subscription uses free pool first', () => {
    expect(resolveEntitlement({ ...base, subscription: null, freeLeft: 3 })).toEqual({ kind: 'free', left: 3 });
  });

  it('free exhausted uses pack credits', () => {
    expect(resolveEntitlement({ ...base, subscription: null, packLeft: 37 })).toEqual({ kind: 'pack', left: 37 });
  });

  it('expired subscription behaves like none', () => {
    const e = resolveEntitlement({
      ...base, subscription: { plan: 'pro', status: 'expired', current_period_end: null }, packLeft: 5,
    });
    expect(e).toEqual({ kind: 'pack', left: 5 });
  });

  it('everything exhausted is none', () => {
    expect(resolveEntitlement({ ...base, subscription: null })).toEqual({ kind: 'none' });
    expect(resolveEntitlement({
      ...base, subscription: { plan: 'starter', status: 'active', current_period_end: null }, monthlyUsed: 999,
    })).toEqual({ kind: 'none' });
  });

  it('custom deduction order is honored (pack before free)', () => {
    const cat: BillingCatalog = { ...catalog, entitlement: { order: ['monthly', 'pack', 'free'] } };
    const e = resolveEntitlement({
      ...base, catalog: cat, subscription: null, freeLeft: 3, packLeft: 5,
    });
    expect(e).toEqual({ kind: 'pack', left: 5 });
  });
});
