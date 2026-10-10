import { describe, it, expect } from 'vitest';
import type { BillingCatalog } from './catalog';
import {
  subscriptionKinds, parseSubKind, planIdFor, kindOfPlanId,
  isDowngrade, orderAmountStr, captureAmountOk, findPack,
} from './catalog';

// Same shape as billing.config.example.ts — 5-months-free annual pricing.
const catalog: BillingCatalog = {
  currency: 'USD',
  plans: [
    {
      key: 'starter', label: 'Starter', monthlyLimit: 500,
      monthly: { price: 6, planIdEnv: 'PAYPAL_PLAN_STARTER_MONTHLY' },
      annual: { price: 30, planIdEnv: 'PAYPAL_PLAN_STARTER_ANNUAL' },
    },
    {
      key: 'pro', label: 'Pro', featured: true, monthlyLimit: 2000,
      monthly: { price: 15, planIdEnv: 'PAYPAL_PLAN_PRO_MONTHLY' },
      annual: { price: 75, planIdEnv: 'PAYPAL_PLAN_PRO_ANNUAL' },
    },
  ],
  packs: [
    { key: 'pack', label: '100 credits', price: 9, credits: 100, description: '100 credits' },
  ],
};

const env = {
  PAYPAL_PLAN_STARTER_MONTHLY: 'P-SM', PAYPAL_PLAN_STARTER_ANNUAL: 'P-SA',
  PAYPAL_PLAN_PRO_MONTHLY: 'P-PM', PAYPAL_PLAN_PRO_ANNUAL: 'P-PA',
};

describe('subscriptionKinds / parseSubKind', () => {
  it('derives kinds from catalog', () => {
    expect(subscriptionKinds(catalog)).toEqual([
      'starter_monthly', 'starter_annual', 'pro_monthly', 'pro_annual',
    ]);
  });
  it('parses kinds', () => {
    expect(parseSubKind('starter_monthly')).toEqual({ plan: 'starter', cycle: 'monthly' });
    expect(parseSubKind('pro_annual')).toEqual({ plan: 'pro', cycle: 'annual' });
  });
  it('rejects non-subscription kinds', () => {
    expect(parseSubKind('pack')).toBeNull();
    expect(parseSubKind('starter_weekly')).toBeNull();
  });
  it('respects monthly-only plans', () => {
    const monthlyOnly: BillingCatalog = {
      ...catalog,
      plans: [{ key: 'solo', label: 'Solo', monthlyLimit: 100, monthly: { price: 5, planIdEnv: 'P-SOLO' } }],
    };
    expect(subscriptionKinds(monthlyOnly)).toEqual(['solo_monthly']);
  });
});

describe('planIdFor', () => {
  it('maps sub kinds to env vars', () => {
    expect(planIdFor(catalog, 'starter_monthly', env)).toBe('P-SM');
    expect(planIdFor(catalog, 'pro_annual', env)).toBe('P-PA');
  });
  it('pack / unknown kinds have no plan id', () => {
    expect(planIdFor(catalog, 'pack', env)).toBeNull();
    expect(planIdFor(catalog, 'nope_monthly', env)).toBeNull();
  });
  it('missing var returns null', () => {
    expect(planIdFor(catalog, 'starter_annual', {})).toBeNull();
  });
});

describe('kindOfPlanId (webhook heal reverse lookup)', () => {
  it('maps plan ids back to kinds', () => {
    expect(kindOfPlanId(catalog, env, 'P-PM')).toBe('pro_monthly');
    expect(kindOfPlanId(catalog, env, 'P-SA')).toBe('starter_annual');
  });
  it('unknown plan id returns null', () => {
    expect(kindOfPlanId(catalog, env, 'P-UNKNOWN')).toBeNull();
  });
});

describe('orderAmountStr', () => {
  it('formats sub and pack amounts', () => {
    expect(orderAmountStr(catalog, 'starter_monthly')).toBe('6.00');
    expect(orderAmountStr(catalog, 'pro_annual')).toBe('75.00');
    expect(orderAmountStr(catalog, 'pack')).toBe('9.00');
  });
});

describe('captureAmountOk', () => {
  it('accepts exact catalog price only', () => {
    expect(captureAmountOk(catalog, 'pack', '9.00')).toBe(true);
    expect(captureAmountOk(catalog, 'pack', '9')).toBe(true);
    expect(captureAmountOk(catalog, 'pack', '0.01')).toBe(false);
    expect(captureAmountOk(catalog, 'pack', '9.99')).toBe(false);
  });
  it('rejects unknown pack keys', () => {
    expect(captureAmountOk(catalog, 'nope', '9.00')).toBe(false);
  });
});

describe('findPack', () => {
  it('finds by key', () => {
    expect(findPack(catalog, 'pack')).toMatchObject({ price: 9, credits: 100 });
    expect(findPack(catalog, 'nope')).toBeUndefined();
  });
});

describe('isDowngrade', () => {
  it('cheaper monthly plan is a downgrade', () => {
    expect(isDowngrade(catalog, 'pro_monthly', 'starter_monthly')).toBe(true);
  });
  it('monthly to annual of same tier is a downgrade (15 -> 6.25/mo)', () => {
    expect(isDowngrade(catalog, 'pro_monthly', 'pro_annual')).toBe(true);
  });
  it('annual pro to monthly starter is a downgrade (6.25 -> 6/mo)', () => {
    expect(isDowngrade(catalog, 'pro_annual', 'starter_monthly')).toBe(true);
  });
  it('starter to pro annual is an upgrade (6 -> 6.25/mo)', () => {
    expect(isDowngrade(catalog, 'starter_monthly', 'pro_annual')).toBe(false);
  });
  it('starter annual to pro annual is an upgrade', () => {
    expect(isDowngrade(catalog, 'starter_annual', 'pro_annual')).toBe(false);
  });
  it('same kind is not a downgrade', () => {
    expect(isDowngrade(catalog, 'pro_monthly', 'pro_monthly')).toBe(false);
    expect(isDowngrade(catalog, 'starter_annual', 'starter_annual')).toBe(false);
  });
  it('annual effective price derives from annual/12 (no hardcoded map)', () => {
    const cat: BillingCatalog = {
      ...catalog,
      plans: catalog.plans.map((p) =>
        p.key === 'starter' ? { ...p, annual: { price: 48, planIdEnv: 'X' } } : p),
    };
    // starter annual = 4/mo effective → starter_monthly (6) → annual is a downgrade
    expect(isDowngrade(cat, 'starter_monthly', 'starter_annual')).toBe(true);
  });
});
