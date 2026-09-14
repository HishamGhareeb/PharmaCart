import { timingSafeEqual } from 'node:crypto';

import { CSRF_HEADER } from './config.ts';

export type GuardResult =
  | { ok: true }
  | { ok: false; status: number; code: 'FOREIGN_ORIGIN' | 'CSRF_TOKEN_INVALID'; message: string };

function sameToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Every state-changing BFF call must be a same-origin request from this app carrying the session's
 * CSRF token. The Origin header is required outright: a missing Origin is treated as foreign rather
 * than trusted, and Sec-Fetch-Site is honoured when the browser supplies it.
 */
export function guardStateChangingRequest(
  request: Request,
  options: { allowedOrigin: string; csrfToken: string | null },
): GuardResult {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin === null || origin !== options.allowedOrigin || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return {
      ok: false,
      status: 403,
      code: 'FOREIGN_ORIGIN',
      message: 'This action only accepts same-origin requests from the local PharmaCart web app.',
    };
  }

  const presented = request.headers.get(CSRF_HEADER);
  if (options.csrfToken === null || presented === null || !sameToken(options.csrfToken, presented)) {
    return {
      ok: false,
      status: 403,
      code: 'CSRF_TOKEN_INVALID',
      message: 'The request did not carry a valid CSRF token for this session.',
    };
  }

  return { ok: true };
}
