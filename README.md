# paypal-billing-kit

Reusable PayPal billing for small SaaS: **subscriptions (monthly/annual) + one-time credit packs**, extracted from a production Cloudflare Workers site (sandbox + live verified, 11 real-world race/edge cases fixed).

New projects integrate by **copying this template and editing one config file** — no billing code written from scratch.

## What's inside

```
src/core/                            ← zero-dependency, any fetch runtime
  paypal.ts                          ← PayPal REST client (createPayPalClient)
  catalog.ts                         ← product catalog types + price/plan helpers
  events.ts                          ← webhook event_type → action mapping
  entitlement.ts                     ← credit-model entitlement resolution

adapters/cloudflare-astro-d1/        ← reference adapter (the stack it shipped on)
  handlers/                          ← framework-agnostic (deps, Request) => Response
  routes/                            ← Astro thin shells (copy into src/pages/api/billing/)
  deps.ts                            ← makeBillingDeps(env, catalog, branding, enabled)
  auth.ts                            ← session-cookie getUserId (KV) — swap for your auth
  email.ts                           ← Resend transport + default email templates
  billingState.ts                    ← subscription + pack + monthly-usage snapshot
  migrations/0001_billing.sql        ← D1 schema (subscriptions/orders/credit_packs/webhook_events)

billing.config.example.ts            ← THE file you edit (plans, prices, packs)
site-branding.example.ts             ← email branding
site-flags.example.ts                ← PAYMENTS_ENABLED kill-switch
.dev.vars.example                    ← secrets template
```

## Why the layers are split this way

Handlers never import `astro`, `cloudflare:workers`, or any platform type. They take a `BillingDeps` seam:

```ts
interface BillingDeps {
  paypal: PayPalClient;                                  // createPayPalClient(config)
  catalog: BillingCatalog;                               // your billing.config.ts
  db: D1Database; kv: KVNamespace;                       // storage bindings
  getUserId: (request: Request) => Promise<string|null>; // YOUR auth
  notify?: (n: BillingNotification) => Promise<void>;    // emails, optional
  paymentsEnabled: boolean;
  publicOrigin?: string;
  envMap?: Record<string, string | undefined>;           // resolves planIdEnv names
}
```

On a different stack (Hono, Next.js, raw Worker, Node) you keep `src/core/` and the handler logic unchanged — only the deps assembly in `deps.ts` and the route shells change.

## Integration checklist (Cloudflare Workers + Astro + D1)

1. **Copy code** into your repo: `src/core/`, `adapters/cloudflare-astro-d1/` (minus `routes/`), and the four `routes/*.ts` into `src/pages/api/billing/`.
2. **Copy configs**: `billing.config.example.ts` → `billing.config.ts`; same for `site-branding.ts`, `site-flags.ts`, `.dev.vars` (gitignored!).
3. **PayPal Developer** (developer.paypal.com):
   - Create an app → get **Client ID + Secret** (sandbox first).
   - Create subscription **plans** for each tier/cycle → get `P-...` plan IDs.
   - Create a **webhook** (or via API, see below) listening for:
     `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
     `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`,
     `PAYMENT.CAPTURE.COMPLETED` → get the **Webhook ID**.
4. **Secrets** (⚠️ Git Bash pipes `\r` into secrets — use `printf`):
   ```bash
   printf '%s' "$VALUE" | npx wrangler secret put PAYPAL_CLIENT_ID
   ```
   Vars (plan IDs, API base) go in `wrangler.jsonc` — **rebuild after changing vars** (`wrangler` reads the built `dist/server/wrangler.json`, not `wrangler.jsonc`).
5. **D1**: create a database, copy `migrations/0001_billing.sql` into your migrations dir, `wrangler d1 migrations apply <db> --remote`.
6. **Pages you must build yourself** (UI is product-specific): `/pricing` (calls `POST /api/billing/checkout {kind}` → redirect to `approvalUrl`), `/billing/success` (packs: `POST /api/billing/capture {orderId}`; subs: poll your entitlement until the webhook lands), `/billing/cancel`, `/account` (billing state + two-click cancel → `POST /api/billing/cancel`).

## Grayscale rollout (sandbox → live) — strongly recommended

Deploy with **sandbox** credentials first, walk a real purchase with a sandbox buyer account on your real domain, then flip to live:

1. Wipe test rows (`subscriptions`, `orders`, `credit_packs`, `webhook_events`) + test sessions.
2. Replace the 3 secrets + plan IDs + `PAYPAL_API_BASE` with live values, **rebuild, redeploy**.
3. Optionally run one real $1 plan purchase end-to-end.

## Operational battle scars baked in

- Plan switch cancels the old PayPal agreement **before** creating the new one (no double-billing window); downgrades take effect at period end via `switch_target`.
- Webhook + return-url capture can race: crediting is claimed with a conditional `UPDATE ... WHERE status='created'`; PayPal `422 ORDER_ALREADY_CAPTURED` maps to the balance path.
- Subscription renewals fire `PAYMENT.CAPTURE.COMPLETED` without a second `ACTIVATED` — the webhook re-syncs `current_period_end` so month-2 access never dies.
- Webhook events are claimed atomically (`INSERT OR IGNORE`) and released on failure so PayPal retries.
- `cancelled` subscriptions keep entitlement until `current_period_end` (grace period).
- Missing `orders` row at activation heals via `custom_id` + reverse plan-ID lookup.

## Customizing the entitlement model

The credit model (free pool → monthly plan → pack, in configurable order) is a **reference implementation**. Feature-gate or seat billing projects should rewrite `resolveEntitlement` / `monthlyLimit` semantics — everything PayPal-related stays untouched.

## Not included (yet)

- Reminder-cron emails (e.g. "you'll be charged in 7 days") — the source project runs this as a separate cron Worker; the schema already has `reminded_period`.
- Pricing/account/success page UI.
- Refund handling.

## Develop

```bash
npm install
npm test        # vitest — core logic, catalog-driven
npm run typecheck
```
