import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPayPalClient } from './paypal';

const config = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'cid',
  clientSecret: 'csecret',
  webhookId: 'WH-1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Route mocked fetch calls by URL suffix and assert the OAuth step happens. */
function mockFetch(handlers: Record<string, (init: RequestInit) => Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith('/v1/oauth2/token')) {
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth !== `Basic ${btoa('cid:csecret')}`) return new Response('bad auth', { status: 401 });
      return Response.json({ access_token: 'TOK' });
    }
    for (const [suffix, handler] of Object.entries(handlers)) {
      if (url.endsWith(suffix)) {
        const auth = (init?.headers as Record<string, string>).authorization;
        if (auth !== 'Bearer TOK') return new Response('bad token', { status: 401 });
        return handler(init ?? {});
      }
    }
    return new Response('not found', { status: 404 });
  }));
  return calls;
}

describe('createPayPalClient', () => {
  it('token -> createOrder happy path', async () => {
    const calls = mockFetch({
      '/v2/checkout/orders': (init) => {
        const body = JSON.parse(String(init.body));
        expect(body.intent).toBe('CAPTURE');
        expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '9.00' });
        return Response.json({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://approve' }] });
      },
    });
    const paypal = createPayPalClient(config);
    const out = await paypal.createOrder({
      amount: '9.00', currency: 'USD', description: 'credits',
      returnUrl: 'https://site/billing/success', cancelUrl: 'https://site/billing/cancel',
    });
    expect(out).toEqual({ id: 'ORDER-1', approvalUrl: 'https://approve' });
    expect(calls[0]).toContain('/v1/oauth2/token');
  });

  it('createSubscription sends plan_id + custom_id', async () => {
    mockFetch({
      '/v1/billing/subscriptions': (init) => {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          plan_id: 'P-1', custom_id: 'user-9',
          application_context: { return_url: 'https://site/ok', cancel_url: 'https://site/no' },
        });
        return Response.json({ id: 'SUB-1', links: [{ rel: 'approve', href: 'https://a' }] });
      },
    });
    const paypal = createPayPalClient(config);
    const out = await paypal.createSubscription('P-1', 'https://site/ok', 'https://site/no', 'user-9');
    expect(out).toEqual({ id: 'SUB-1', approvalUrl: 'https://a' });
  });

  it('captureOrder returns status and captured value', async () => {
    mockFetch({
      '/v2/checkout/orders/O-9/capture': () =>
        Response.json({
          status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ amount: { value: '9.00' } }] } }],
        }),
    });
    const paypal = createPayPalClient(config);
    expect(await paypal.captureOrder('O-9')).toEqual({ status: 'COMPLETED', value: '9.00' });
  });

  it('captureOrder throws with status on failure (422 included)', async () => {
    mockFetch({
      '/v2/checkout/orders/O-9/capture': () =>
        Response.json({ name: 'UNPROCESSABLE_ENTITY', message: 'Order already captured' }, { status: 422 }),
    });
    const paypal = createPayPalClient(config);
    await expect(paypal.captureOrder('O-9')).rejects.toThrow('paypal capture failed: 422');
  });

  it('cancelSubscription posts reason', async () => {
    mockFetch({
      '/v1/billing/subscriptions/S-1/cancel': (init) => {
        expect(JSON.parse(String(init.body))).toEqual({ reason: 'user_cancelled' });
        return new Response(null, { status: 204 });
      },
    });
    const paypal = createPayPalClient(config);
    await paypal.cancelSubscription('S-1');
  });

  it('getSubscriptionDetail returns null on failure', async () => {
    mockFetch({ '/v1/billing/subscriptions/S-1': () => new Response('boom', { status: 500 }) });
    const paypal = createPayPalClient(config);
    expect(await paypal.getSubscriptionDetail('S-1')).toBeNull();
  });

  it('getSubscriptionDetail parses plan_id and next billing time', async () => {
    mockFetch({
      '/v1/billing/subscriptions/S-1': () =>
        Response.json({ plan_id: 'P-1', billing_info: { next_billing_time: '2026-11-01T00:00:00Z' } }),
    });
    const paypal = createPayPalClient(config);
    expect(await paypal.getSubscriptionDetail('S-1')).toEqual({
      plan_id: 'P-1', billing_info: { next_billing_time: '2026-11-01T00:00:00Z' },
    });
  });

  it('verifyWebhook posts transmission headers and returns success flag', async () => {
    mockFetch({
      '/v1/notifications/verify-webhook-signature': (init) => {
        const body = JSON.parse(String(init.body));
        expect(body.webhook_id).toBe('WH-1');
        expect(body.transmission_id).toBe('T-1');
        expect(body.webhook_event.event_type).toBe('PAYMENT.CAPTURE.COMPLETED');
        return Response.json({ verification_status: 'SUCCESS' });
      },
    });
    const headers = new Headers({
      'paypal-auth-algo': 'algo', 'paypal-cert-url': 'https://cert',
      'paypal-transmission-id': 'T-1', 'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': 'now',
    });
    const paypal = createPayPalClient(config);
    expect(await paypal.verifyWebhook(headers, '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}')).toBe(true);
  });

  it('verifyWebhook fails closed on non-SUCCESS and on transport error', async () => {
    mockFetch({
      '/v1/notifications/verify-webhook-signature': () => Response.json({ verification_status: 'FAILURE' }),
    });
    const paypal = createPayPalClient(config);
    expect(await paypal.verifyWebhook(new Headers(), '{}')).toBe(false);
  });

  it('verifyWebhook requires webhookId in config', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const paypal = createPayPalClient({ ...config, webhookId: undefined });
    await expect(paypal.verifyWebhook(new Headers(), '{}')).rejects.toThrow('webhookId');
  });
});
