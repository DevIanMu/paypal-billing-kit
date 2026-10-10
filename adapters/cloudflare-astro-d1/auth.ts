/** Session-cookie auth helpers (reference implementation of the getUserId seam). */

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Session tokens are generateToken() output: 64 lowercase hex chars. */
export function isSessionToken(v: string | null): v is string {
  return !!v && /^[0-9a-f]{64}$/.test(v);
}

/**
 * getUserId seam for BillingDeps: session cookie → KV lookup.
 * Expects KV entries shaped `{ userId: string }` under `session:{token}`.
 */
export function kvSessionAuth(kv: KVNamespace) {
  return async (request: Request): Promise<string | null> => {
    const token = parseSessionToken(request.headers.get('cookie'));
    if (!isSessionToken(token)) return null;
    const sess = await kv.get<{ userId: string }>(`session:${token}`, 'json');
    return sess?.userId ?? null;
  };
}
