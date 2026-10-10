import type { EmailMessage, BillingNotification } from './types';

/** Resend transport. Omit RESEND_API_KEY to disable all billing emails. */
export function createResendSender(config: { apiKey: string; from: string }) {
  return async function sendEmail(msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.from, ...msg }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status}`);
  };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Default notification templates; override any of them per project. */
export interface EmailTemplates {
  siteName: string;
  accountUrl: string;
  pricingUrl: string;
  packLabel: (packKey: string) => string;
}

export function createEmailNotifier(
  sendEmail: (msg: EmailMessage) => Promise<void>,
  t: EmailTemplates,
) {
  return async function notify(n: BillingNotification): Promise<void> {
    const wrap = (title: string, body: string) =>
      `<!doctype html><html><body style="margin:0;padding:24px;background:#faf9f5;font-family:Georgia,serif;color:#141413">
<h1 style="font-size:20px;font-weight:500">${title}</h1>
<div style="font-size:14px;line-height:1.6;font-family:Arial,sans-serif;color:#3d3d3a">${body}</div>
<p style="font-size:12px;color:#8e8b82;margin-top:24px;font-family:Arial,sans-serif">${esc(t.siteName)} · <a href="${t.accountUrl}">Manage your account</a></p>
</body></html>`;

    if (n.type === 'payment_success') {
      await sendEmail({
        to: n.email,
        subject: 'Your subscription is active',
        html: wrap(
          'Thanks — your subscription is active',
          `<p>Your <b>${esc(n.plan)}</b> plan (${esc(n.cycle)}) is now active.${
            n.periodEnd ? ` Your next charge is on <b>${esc(n.periodEnd.slice(0, 10))}</b>.` : ''
          }</p>
           <p>You can manage or cancel it any time from your <a href="${t.accountUrl}">Account page</a> — two clicks, no contact form.</p>`,
        ),
      });
    }

    if (n.type === 'pack_paid') {
      await sendEmail({
        to: n.email,
        subject: `Your ${esc(t.packLabel(n.packKey))} are ready`,
        html: wrap(
          'Credits added',
          `<p>Your one-time purchase is complete: <b>${esc(t.packLabel(n.packKey))}</b> have been added to your account. They never expire and are used automatically after your free allowance.</p>`,
        ),
      });
    }

    if (n.type === 'cancelled') {
      await sendEmail({
        to: n.email,
        subject: 'Your subscription has been cancelled',
        html: wrap(
          'Subscription cancelled',
          `<p>Your subscription is cancelled as requested. You keep full access until <b>${esc(n.accessUntil.slice(0, 10))}</b>, and no further charges will be made.</p>
           <p>Changed your mind? You can resubscribe any time from the <a href="${t.pricingUrl}">pricing page</a>.</p>`,
        ),
      });
    }
  };
}
