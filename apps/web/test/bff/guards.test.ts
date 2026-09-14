import { describe, expect, it } from 'vitest';

import { parseCookies, serializeCookie, clearCookie } from '../../src/lib/cookies.ts';
import { guardStateChangingRequest } from '../../src/lib/csrf.ts';

const ORIGIN = 'http://127.0.0.1:3001';

function post(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/bff/scope`, { method: 'POST', headers });
}

describe('cookies', () => {
  it('parses a cookie header without leaking neighbouring values', () => {
    expect(parseCookies('a=1; pharmacart_web_session=abc; b=2')).toEqual({
      a: '1',
      pharmacart_web_session: 'abc',
      b: '2',
    });
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('broken')).toEqual({});
  });

  it('serialises an HttpOnly SameSite path-scoped cookie with a bounded lifetime', () => {
    const header = serializeCookie('pharmacart_web_session', 'opaque-value', { maxAgeSeconds: 300 });
    expect(header).toContain('pharmacart_web_session=opaque-value');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=300');
  });

  it('clears a cookie with an immediate expiry', () => {
    const header = clearCookie('pharmacart_web_session');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('pharmacart_web_session=;');
  });

  it('refuses cookie values that would break the header', () => {
    expect(() => serializeCookie('pharmacart_web_session', 'bad;value', { maxAgeSeconds: 10 })).toThrow();
  });
});

describe('state-changing request guard', () => {
  const csrfToken = 'csrf-token-value-0123456789abcdef';

  it('accepts a same-origin request carrying the matching CSRF token', () => {
    const result = guardStateChangingRequest(
      post({ origin: ORIGIN, 'x-pharmacart-csrf': csrfToken, 'sec-fetch-site': 'same-origin' }),
      { allowedOrigin: ORIGIN, csrfToken },
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses a foreign Origin header', () => {
    const result = guardStateChangingRequest(
      post({ origin: 'http://evil.example.com', 'x-pharmacart-csrf': csrfToken }),
      { allowedOrigin: ORIGIN, csrfToken },
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: 'FOREIGN_ORIGIN' });
  });

  it('refuses a request with no Origin header at all', () => {
    const result = guardStateChangingRequest(post({ 'x-pharmacart-csrf': csrfToken }), {
      allowedOrigin: ORIGIN,
      csrfToken,
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'FOREIGN_ORIGIN' });
  });

  it('refuses a cross-site fetch metadata hint even when Origin matches', () => {
    const result = guardStateChangingRequest(
      post({ origin: ORIGIN, 'x-pharmacart-csrf': csrfToken, 'sec-fetch-site': 'cross-site' }),
      { allowedOrigin: ORIGIN, csrfToken },
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: 'FOREIGN_ORIGIN' });
  });

  it('refuses a missing or mismatched CSRF token', () => {
    expect(guardStateChangingRequest(post({ origin: ORIGIN }), { allowedOrigin: ORIGIN, csrfToken }))
      .toMatchObject({ ok: false, status: 403, code: 'CSRF_TOKEN_INVALID' });
    expect(
      guardStateChangingRequest(post({ origin: ORIGIN, 'x-pharmacart-csrf': 'wrong' }), {
        allowedOrigin: ORIGIN,
        csrfToken,
      }),
    ).toMatchObject({ ok: false, status: 403, code: 'CSRF_TOKEN_INVALID' });
  });

  it('refuses when there is no session token to compare against', () => {
    expect(
      guardStateChangingRequest(post({ origin: ORIGIN, 'x-pharmacart-csrf': csrfToken }), {
        allowedOrigin: ORIGIN,
        csrfToken: null,
      }),
    ).toMatchObject({ ok: false, status: 403, code: 'CSRF_TOKEN_INVALID' });
  });
});
