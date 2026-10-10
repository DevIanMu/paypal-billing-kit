/** Webhook event_type → handler action mapping. */

export type WebhookAction = 'activate' | 'deactivate' | 'pack_paid' | 'ignore';

export function eventToAction(eventType: string): WebhookAction {
  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
      return 'activate';
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return 'deactivate';
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'pack_paid';
    default:
      return 'ignore';
  }
}

/** Sub-row status derived from the deactivation event type. */
export function statusFromEvent(eventType: string): string {
  if (eventType.includes('CANCELLED')) return 'cancelled';
  if (eventType.includes('SUSPENDED')) return 'suspended';
  return 'expired';
}
