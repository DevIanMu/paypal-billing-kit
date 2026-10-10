import { describe, it, expect } from 'vitest';
import { eventToAction, statusFromEvent } from './events';

describe('eventToAction', () => {
  it('subscription lifecycle', () => {
    expect(eventToAction('BILLING.SUBSCRIPTION.ACTIVATED')).toBe('activate');
    expect(eventToAction('BILLING.SUBSCRIPTION.CANCELLED')).toBe('deactivate');
    expect(eventToAction('BILLING.SUBSCRIPTION.EXPIRED')).toBe('deactivate');
    expect(eventToAction('BILLING.SUBSCRIPTION.SUSPENDED')).toBe('deactivate');
  });
  it('pack payment', () => {
    expect(eventToAction('PAYMENT.CAPTURE.COMPLETED')).toBe('pack_paid');
  });
  it('everything else ignored', () => {
    expect(eventToAction('PAYMENT.CAPTURE.DENIED')).toBe('ignore');
    expect(eventToAction('BILLING.SUBSCRIPTION.PAYMENT.FAILED')).toBe('ignore');
  });
});

describe('statusFromEvent', () => {
  it('maps deactivation types to row status', () => {
    expect(statusFromEvent('BILLING.SUBSCRIPTION.CANCELLED')).toBe('cancelled');
    expect(statusFromEvent('BILLING.SUBSCRIPTION.SUSPENDED')).toBe('suspended');
    expect(statusFromEvent('BILLING.SUBSCRIPTION.EXPIRED')).toBe('expired');
  });
});
