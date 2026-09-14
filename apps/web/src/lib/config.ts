/**
 * Configuration for the local synthetic web loop.
 *
 * Every outbound destination is pinned to an http loopback origin. The environment may move a port,
 * but it can never point this app at a remote host, a path, or a credentialed URL, and no request
 * input ever contributes to a destination.
 */

export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:3001';
export const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3000';
export const DEFAULT_OIDC_ISSUER = 'http://127.0.0.1:55433';

/** Registered separately from the API's `pharmacart-local` client; see infra/oidc/provider.ts. */
export const WEB_CLIENT_ID = 'pharmacart-web-local';
export const CALLBACK_PATH = '/auth/callback';
export const OIDC_SCOPE = 'openid pharmacart';

export const SESSION_COOKIE = 'pharmacart_web_session';
export const LOGIN_COOKIE = 'pharmacart_web_login';
export const CSRF_HEADER = 'x-pharmacart-csrf';

export const DEFAULT_SESSION_SECONDS = 300;
export const MIN_SESSION_SECONDS = 30;
export const MAX_SESSION_SECONDS = 900;
export const PENDING_LOGIN_SECONDS = 600;
export const MAX_BFF_BODY_BYTES = 8192;

/**
 * Growth bounds for the development session store. `GET /auth/login` needs no session, so pending
 * logins are the one thing an unauthenticated caller can allocate; both maps are swept and capped so
 * neither can grow for as long as the dev server runs. See src/lib/session.ts.
 */
export const MAX_PENDING_LOGINS = 256;
export const MAX_LIVE_SESSIONS = 256;

export type WebConfig = Readonly<{
  webOrigin: string;
  apiOrigin: string;
  oidcIssuer: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  sessionMaxSeconds: number;
}>;

const LOOPBACK_HOST = '127.0.0.1';

export function assertLoopbackOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST) {
    throw new ConfigurationError(`${label} must be an http://${LOOPBACK_HOST} loopback origin`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new ConfigurationError(`${label} must be a bare origin with no path, query, fragment or credentials`);
  }
  return url.origin;
}

function readSessionSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SESSION_SECONDS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigurationError('PHARMACART_WEB_SESSION_MAX_SECONDS must be a positive whole number of seconds');
  }
  const seconds = Number(raw);
  if (seconds < MIN_SESSION_SECONDS || seconds > MAX_SESSION_SECONDS) {
    throw new ConfigurationError(
      `PHARMACART_WEB_SESSION_MAX_SECONDS must be between ${MIN_SESSION_SECONDS} and ${MAX_SESSION_SECONDS}`,
    );
  }
  return seconds;
}

export function loadWebConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const webOrigin = assertLoopbackOrigin(env.PHARMACART_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN, 'PHARMACART_WEB_ORIGIN');
  const apiOrigin = assertLoopbackOrigin(env.PHARMACART_WEB_API_ORIGIN ?? DEFAULT_API_ORIGIN, 'PHARMACART_WEB_API_ORIGIN');
  const oidcIssuer = assertLoopbackOrigin(
    env.PHARMACART_WEB_OIDC_ISSUER ?? DEFAULT_OIDC_ISSUER,
    'PHARMACART_WEB_OIDC_ISSUER',
  );
  return Object.freeze({
    webOrigin,
    apiOrigin,
    oidcIssuer,
    // The API is also the OAuth resource indicator, matching infra/oidc/provider.ts LOCAL_RESOURCE.
    resource: apiOrigin,
    clientId: WEB_CLIENT_ID,
    redirectUri: `${webOrigin}${CALLBACK_PATH}`,
    sessionMaxSeconds: readSessionSeconds(env.PHARMACART_WEB_SESSION_MAX_SECONDS),
  });
}
