/**
 * Framework-agnostic PayPal REST client. Zero dependencies; works in any
 * runtime with global fetch + btoa (Cloudflare Workers, Node 18+, Deno, Bun).
 *
 * Credentials are injected per project via PayPalConfig — never hardcoded.
 * Sandbox: apiBase https://api-m.sandbox.paypal.com
 * Live:     apiBase https://api-m.paypal.com
 */

export interface PayPalConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  /** Required only for verifyWebhook(). Create via POST /v1/notifications/webhooks. */
  webhookId?: string;
}

export interface PayPalClient {
  createSubscription(
    planId: string,
    returnUrl: string,
    cancelUrl: string,
    customId: string,
  ): Promise<{ id: string; approvalUrl: string }>;
  createOrder(o: {
    amount: string; // e.g. "9.00"
    currency: string; // e.g. "USD"
    description: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; approvalUrl: string }>;
  captureOrder(orderId: string): Promise<{ status: string; value: string | null }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  getSubscriptionDetail(
    subscriptionId: string,
  ): Promise<{ plan_id?: string; billing_info?: { next_billing_time?: string } } | null>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
}

async function getAccessToken(config: PayPalConfig): Promise<string> {
  const res = await fetch(`${config.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`paypal token failed: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

function approvalUrlOf(json: { links?: { rel: string; href: string }[] }): string {
  return json.links?.find((l) => l.rel === 'approve')?.href ?? '';
}

export function createPayPalClient(config: PayPalConfig): PayPalClient {
  return {
    async createSubscription(planId, returnUrl, cancelUrl, customId) {
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v1/billing/subscriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          plan_id: planId,
          custom_id: customId,
          application_context: { return_url: returnUrl, cancel_url: cancelUrl },
        }),
      });
      const json = (await res.json()) as { id: string; links?: { rel: string; href: string }[] };
      if (!res.ok || !json.id) throw new Error(`paypal create subscription failed: ${res.status}`);
      return { id: json.id, approvalUrl: approvalUrlOf(json) };
    },

    async createOrder({ amount, currency, description, returnUrl, cancelUrl }) {
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v2/checkout/orders`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: currency, value: amount }, description }],
          application_context: { return_url: returnUrl, cancel_url: cancelUrl },
        }),
      });
      const json = (await res.json()) as { id: string; links?: { rel: string; href: string }[] };
      if (!res.ok || !json.id) throw new Error(`paypal create order failed: ${res.status}`);
      return { id: json.id, approvalUrl: approvalUrlOf(json) };
    },

    async captureOrder(orderId) {
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const json = (await res.json()) as {
        status: string;
        purchase_units?: { payments?: { captures?: { amount?: { value?: string } }[] } }[];
      };
      if (!res.ok) throw new Error(`paypal capture failed: ${res.status}`);
      return {
        status: json.status,
        value: json.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? null,
      };
    },

    async cancelSubscription(subscriptionId) {
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'user_cancelled' }),
      });
      if (!res.ok) throw new Error(`paypal cancel subscription failed: ${res.status}`);
    },

    async getSubscriptionDetail(subscriptionId) {
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v1/billing/subscriptions/${subscriptionId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        plan_id?: string;
        billing_info?: { next_billing_time?: string };
      };
    },

    async verifyWebhook(headers, rawBody) {
      if (!config.webhookId) throw new Error('webhookId required for verifyWebhook');
      const token = await getAccessToken(config);
      const res = await fetch(`${config.apiBase}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          auth_algo: headers.get('paypal-auth-algo'),
          cert_url: headers.get('paypal-cert-url'),
          transmission_id: headers.get('paypal-transmission-id'),
          transmission_sig: headers.get('paypal-transmission-sig'),
          transmission_time: headers.get('paypal-transmission-time'),
          webhook_id: config.webhookId,
          webhook_event: JSON.parse(rawBody),
        }),
      });
      if (!res.ok) return false;
      const { verification_status } = (await res.json()) as { verification_status: string };
      return verification_status === 'SUCCESS';
    },
  };
}
