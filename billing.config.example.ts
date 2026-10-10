/**
 * YOUR product catalog — the one file every new project edits.
 * Copy to billing.config.ts and adjust.
 *
 * - Plan IDs are referenced by ENV VAR NAME and resolved from your environment
 *   at runtime (never hardcode P-xxx IDs here).
 * - annual.price = the full once-a-year charge. Effective monthly cost for
 *   downgrade comparison derives as annual.price / 12 (e.g. 75/12 = 6.25).
 * - monthlyLimit is only used by the credit entitlement model; feature-gate
 *   projects can repurpose it or ignore entitlement entirely.
 */

import type { BillingCatalog } from './src/core/catalog';

export const catalog: BillingCatalog = {
  currency: 'USD',
  plans: [
    {
      key: 'starter',
      label: 'Starter',
      monthly: { price: 6, planIdEnv: 'PAYPAL_PLAN_STARTER_MONTHLY' },
      annual: { price: 30, planIdEnv: 'PAYPAL_PLAN_STARTER_ANNUAL' }, // = 5 months, "SAVE 58%"
      monthlyLimit: 500,
    },
    {
      key: 'pro',
      label: 'Pro',
      featured: true,
      monthly: { price: 15, planIdEnv: 'PAYPAL_PLAN_PRO_MONTHLY' },
      annual: { price: 75, planIdEnv: 'PAYPAL_PLAN_PRO_ANNUAL' },
      monthlyLimit: 2000,
    },
  ],
  packs: [
    {
      key: 'pack',
      label: '100 credits',
      price: 9,
      credits: 100,
      description: 'My Product — 100 credits (one-time, never expire)',
    },
  ],
  // Deduction priority after the free allowance. Default shown explicitly.
  entitlement: { order: ['monthly', 'free', 'pack'] },
};
