import { createPayPalClient } from '../../src/core/paypal';
import type { BillingCatalog } from '../../src/core/catalog';
import type { BillingDeps } from './types';
import { kvSessionAuth } from './auth';
import { createResendSender, createEmailNotifier } from './email';

/** Shape of the Cloudflare env this adapter expects (wrangler bindings + vars/secrets). */
export interface BillingEnv {
  DB: D1Database;
  QUOTA: KVNamespace; // also holds sessions in the reference project
  PAYPAL_API_BASE: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_WEBHOOK_ID: string;
  PUBLIC_ORIGIN?: string;
  RESEND_API_KEY?: string;
  [key: string]: unknown;
}

export interface SiteBranding {
  siteName: string;
  fromEmail: string; // e.g. 'My Site <no-reply@example.com>'
  accountUrl: string;
  pricingUrl: string;
  packLabel: (packKey: string) => string;
}

/** Assemble BillingDeps from Cloudflare bindings. Adjust to your own env shape. */
export function makeBillingDeps(env: BillingEnv, catalog: BillingCatalog, branding: SiteBranding, paymentsEnabled: boolean): BillingDeps {
  const envMap = env as Record<string, string | undefined>;
  const sendEmail = env.RESEND_API_KEY
    ? createResendSender({ apiKey: env.RESEND_API_KEY, from: branding.fromEmail })
    : undefined;
  return {
    paypal: createPayPalClient({
      apiBase: env.PAYPAL_API_BASE,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
    }),
    catalog,
    db: env.DB,
    kv: env.QUOTA,
    getUserId: kvSessionAuth(env.QUOTA),
    notify: sendEmail ? createEmailNotifier(sendEmail, branding) : undefined,
    paymentsEnabled,
    publicOrigin: env.PUBLIC_ORIGIN,
    envMap,
  };
}
