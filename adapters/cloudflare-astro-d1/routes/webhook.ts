import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleWebhook } from '../../adapters/cloudflare-astro-d1/handlers/webhook';
import { makeBillingDeps, type BillingEnv } from '../../adapters/cloudflare-astro-d1/deps';
import { catalog } from '../../billing.config';
import { branding } from '../../site-branding';
import { PAYMENTS_ENABLED } from '../../site-flags';

export const prerender = false;

export const POST: APIRoute = async ({ request }) =>
  handleWebhook(makeBillingDeps(env as unknown as BillingEnv, catalog, branding, PAYMENTS_ENABLED), request);
