/**
 * Site branding for billing emails.
 * Copy to site-branding.ts and adjust.
 */

import type { SiteBranding } from './adapters/cloudflare-astro-d1/deps';

export const branding: SiteBranding = {
  siteName: 'My Product',
  fromEmail: 'My Product <no-reply@example.com>',
  accountUrl: 'https://example.com/account',
  pricingUrl: 'https://example.com/pricing',
  packLabel: (packKey) => (packKey === 'pack' ? '100 credits' : packKey),
};
