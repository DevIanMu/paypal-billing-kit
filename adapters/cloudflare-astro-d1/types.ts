/**
 * Deps seam between the framework-agnostic handlers and YOUR project.
 *
 * A different stack (Hono, Next.js, raw Worker, Node) only needs to assemble
 * this interface differently — the handler business logic is unchanged:
 *   - paypal:     createPayPalClient({ apiBase, clientId, clientSecret, webhookId })
 *   - catalog:    your billing.config.ts
 *   - db/kv:      your storage bindings
 *   - getUserId:  your auth (reference impl: session cookie → KV lookup)
 *   - sendEmail:  optional; omit to disable all billing emails
 */

import type { PayPalClient } from '../../src/core/paypal';
import type { BillingCatalog } from '../../src/core/catalog';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type BillingNotification =
  | { type: 'payment_success'; email: string; plan: string; cycle: string; periodEnd: string | null }
  | { type: 'pack_paid'; email: string; packKey: string }
  | { type: 'cancelled'; email: string; accessUntil: string };

export interface BillingDeps {
  paypal: PayPalClient;
  catalog: BillingCatalog;
  db: D1Database;
  /** Monthly usage counter (musage keys). Swap for another store if you like. */
  kv: KVNamespace;
  /** Auth seam: return the signed-in user's ID, or null. */
  getUserId: (request: Request) => Promise<string | null>;
  /** Optional notification sink (emails). Omit to disable silently. */
  notify?: (n: BillingNotification) => Promise<void>;
  /**
   * Environment map used to resolve catalog planIdEnv names to PayPal plan IDs
   * (e.g. wrangler vars/secrets). Not needed if you inline plan IDs instead.
   */
  envMap?: Record<string, string | undefined>;
  paymentsEnabled: boolean;
  publicOrigin?: string;
  /** Redirect targets for PayPal approval flows. */
  successPath?: string; // default '/billing/success'
  cancelPath?: string; // default '/billing/cancel'
}

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
