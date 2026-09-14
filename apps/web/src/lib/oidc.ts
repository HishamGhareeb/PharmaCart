import { createHash, randomBytes } from 'node:crypto';

import { OIDC_SCOPE, assertLoopbackOrigin } from './config.ts';

/**
 * Authorization-code + PKCE client for the existing local synthetic OIDC provider.
 *
 * Runs on the server only. The access token is returned to the caller and stored server-side; it is
 * never written into a cookie, a response body or the rendered page. Discovered endpoints must live
 * on the configured issuer origin, so a tampered discovery document cannot move the flow elsewhere.
 */

export type AuthorizationRequest = { url: string; state: string; codeVerifier: string };
export type TokenResult = { accessToken: string; expiresInSeconds: number };

export type OidcClient = {
  createAuthorizationRequest(): Promise<AuthorizationRequest>;
  exchangeAuthorizationCode(input: { code: string; codeVerifier: string }): Promise<TokenResult>;
};

export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

type Discovery = { authorizationEndpoint: string; tokenEndpoint: string };

export function createOidcClient(options: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): OidcClient {
  const issuer = assertLoopbackOrigin(options.issuer, 'OIDC issuer');
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let cached: Discovery | null = null;

  function endpointOnIssuer(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`The discovery document is missing ${label}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`The discovery document ${label} is not a URL on the configured issuer`);
    }
    if (url.origin !== issuer) {
      throw new Error(`The discovery document ${label} is not on the configured issuer origin`);
    }
    return url.toString();
  }

  async function discover(): Promise<Discovery> {
    if (cached) return cached;
    const response = await call(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`The local identity provider returned ${response.status} for discovery`);
    const document = (await response.json()) as Record<string, unknown>;
    if (document.issuer !== issuer) {
      throw new Error('The discovery document issuer does not match the configured issuer');
    }
    cached = {
      authorizationEndpoint: endpointOnIssuer(document.authorization_endpoint, 'authorization_endpoint'),
      tokenEndpoint: endpointOnIssuer(document.token_endpoint, 'token_endpoint'),
    };
    return cached;
  }

  return {
    async createAuthorizationRequest() {
      const { authorizationEndpoint } = await discover();
      const codeVerifier = randomBytes(32).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      const url = new URL(authorizationEndpoint);
      for (const [name, value] of [
        ['client_id', options.clientId],
        ['response_type', 'code'],
        ['redirect_uri', options.redirectUri],
        ['scope', OIDC_SCOPE],
        ['resource', options.resource],
        ['code_challenge', deriveCodeChallenge(codeVerifier)],
        ['code_challenge_method', 'S256'],
        ['state', state],
      ] as const) {
        url.searchParams.set(name, value);
      }
      return { url: url.toString(), state, codeVerifier };
    },

    async exchangeAuthorizationCode({ code, codeVerifier }) {
      const { tokenEndpoint } = await discover();
      const response = await call(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        // A public client: there is no secret to send, and PKCE is what binds the code to this app.
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: options.clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: options.redirectUri,
          resource: options.resource,
        }).toString(),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`The local token endpoint refused the code: ${String(payload.error ?? response.status)}`);
      }
      const accessToken = payload.access_token;
      const expiresIn = payload.expires_in;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new Error('The token response did not contain an access token');
      }
      if (String(payload.token_type).toLowerCase() !== 'bearer') {
        throw new Error('The token response did not contain a bearer token');
      }
      if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
        throw new Error('The token response did not contain a usable expiry');
      }
      return { accessToken, expiresInSeconds: expiresIn };
    },
  };
}
