/**
 * Product catalog: the ONLY file a new project must edit.
 *
 * Everything price/shape-related that used to be hardcoded (plan IDs, pack
 * price/credits, monthly limits, downgrade comparison) derives from here.
 * Plan IDs are referenced by ENV VAR NAME (planIdEnv) and resolved at runtime
 * from the project's environment — secrets/IDs never live in code.
 */

export interface PlanCycleDef {
  /** Gross price for this cycle (annual = the full once-a-year charge). */
  price: number;
  /** Name of the env var holding the PayPal plan ID (P-xxx). */
  planIdEnv: string;
}

export interface PlanDef {
  key: string; // e.g. 'starter'
  label: string;
  featured?: boolean;
  monthly: PlanCycleDef;
  /** Omit for monthly-only plans. Annual price is charged once per year. */
  annual?: PlanCycleDef;
  /** Usage units included per month; required for the credit entitlement model. */
  monthlyLimit: number;
}

export interface PackDef {
  key: string; // e.g. 'pack'
  label: string;
  price: number;
  credits: number;
  /** Shown on the PayPal order (purchase unit description). */
  description: string;
}

export interface EntitlementConfig {
  /** Deduction priority. Default: ['monthly', 'free', 'pack']. */
  order?: EntitlementKind[];
}

export interface BillingCatalog {
  currency: string;
  plans: PlanDef[];
  packs: PackDef[];
  entitlement?: EntitlementConfig;
}

export type EntitlementKind = 'monthly' | 'free' | 'pack';

/** A purchasable subscription kind: `${planKey}_${cycle}`. */
export type SubKind = string;

export function subscriptionKinds(catalog: BillingCatalog): SubKind[] {
  const kinds: SubKind[] = [];
  for (const p of catalog.plans) {
    kinds.push(`${p.key}_monthly`);
    if (p.annual) kinds.push(`${p.key}_annual`);
  }
  return kinds;
}

export function packKeys(catalog: BillingCatalog): string[] {
  return catalog.packs.map((p) => p.key);
}

export function parseSubKind(kind: string): { plan: string; cycle: 'monthly' | 'annual' } | null {
  const [plan, cycle] = kind.split('_');
  if (!plan || (cycle !== 'monthly' && cycle !== 'annual')) return null;
  return { plan, cycle };
}

export function findPlan(catalog: BillingCatalog, planKey: string): PlanDef | undefined {
  return catalog.plans.find((p) => p.key === planKey);
}

/** Resolve a subscription kind to its PayPal plan ID via the project's env. */
export function planIdFor(catalog: BillingCatalog, kind: SubKind, env: Record<string, string | undefined>): string | null {
  const parsed = parseSubKind(kind);
  if (!parsed) return null;
  const cycleDef = findPlan(catalog, parsed.plan)?.[parsed.cycle];
  return cycleDef ? (env[cycleDef.planIdEnv] ?? null) : null;
}

/** Reverse lookup: PayPal plan_id → subscription kind (webhook heal path). */
export function kindOfPlanId(
  catalog: BillingCatalog,
  env: Record<string, string | undefined>,
  planId: string,
): SubKind | null {
  for (const kind of subscriptionKinds(catalog)) {
    if (planIdFor(catalog, kind, env) === planId) return kind;
  }
  return null;
}

/** Effective monthly cost: annual price spread over 12 months. */
function effectiveMonthlyPrice(catalog: BillingCatalog, kind: SubKind): number {
  const parsed = parseSubKind(kind);
  if (!parsed) return 0;
  const cycleDef = findPlan(catalog, parsed.plan)?.[parsed.cycle];
  if (!cycleDef) return 0;
  return parsed.cycle === 'annual' ? cycleDef.price / 12 : cycleDef.price;
}

/** Downgrade = the new kind costs less per effective month than the current one. */
export function isDowngrade(catalog: BillingCatalog, from: SubKind, to: SubKind): boolean {
  return effectiveMonthlyPrice(catalog, to) < effectiveMonthlyPrice(catalog, from);
}

/** Precomputed amount string for the orders row, e.g. "75.00". */
export function orderAmountStr(catalog: BillingCatalog, kind: SubKind | string): string {
  const pack = catalog.packs.find((p) => p.key === kind);
  if (pack) return pack.price.toFixed(2);
  const parsed = parseSubKind(kind);
  const cycleDef = parsed ? findPlan(catalog, parsed.plan)?.[parsed.cycle] : undefined;
  return cycleDef ? cycleDef.price.toFixed(2) : '0.00';
}

export function findPack(catalog: BillingCatalog, packKey: string): PackDef | undefined {
  return catalog.packs.find((p) => p.key === packKey);
}

/** Capture amount check for one-time pack orders: exact catalog price only. */
export function captureAmountOk(catalog: BillingCatalog, packKey: string, value: string): boolean {
  const pack = findPack(catalog, packKey);
  return !!pack && Number(value) === pack.price;
}
