/**
 * Cookie helpers for the BFF.
 *
 * Cookies only ever carry opaque server-side handles. Tokens, PKCE verifiers and login state stay in
 * the server-side store. `Secure` is deliberately omitted because this app is only ever served over
 * http on the loopback interface; see docs/testing/local-web-loop.md.
 */

const UNSAFE_VALUE = /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/;

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const pair = part.trim();
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, options: { maxAgeSeconds: number }): string {
  if (UNSAFE_VALUE.test(name) || (value !== '' && UNSAFE_VALUE.test(value))) {
    throw new Error('Cookie name and value must be token-safe');
  }
  if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) {
    throw new Error('Cookie Max-Age must be a non-negative whole number of seconds');
  }
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0 });
}
