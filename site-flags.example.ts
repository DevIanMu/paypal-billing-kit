/**
 * Feature switch. Copy to site-flags.ts.
 * Flip PAYMENTS_ENABLED to false to 503 every billing endpoint and hide
 * purchase UI — useful while a payment account is under review.
 */
export const PAYMENTS_ENABLED = true;
