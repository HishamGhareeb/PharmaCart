import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createOidcClient, deriveCodeChallenge } from '../../src/lib/oidc.ts';

const ISSUER = 'http://127.0.0.1:55433';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function oidc(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchImpl = vi.fn(handler);
  return {
    fetchImpl,
    client: createOidcClient({
      issuer: ISSUER,
      clientId: 'pharmacart-web-local',
      redirectUri: 'http://127.0.0.1:3001/auth/callback',
      resource: 'http://127.0.0.1:3000',
      fetchImpl: fetchImpl as never,
    }),
  };
}

describe('PKCE', () => {
  it('derives an S256 challenge that matches the reference hash', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('local OIDC client', () => {
  it('builds an authorization URL with state, PKCE and the pinned resource', async () => {
    const { client } = oidc(async () => json(DISCOVERY));
    const request = await client.createAuthorizationRequest();

    const url = new URL(request.url);
    expect(url.origin).toBe(ISSUER);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('client_id')).toBe('pharmacart-web-local');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3001/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid pharmacart');
    expect(url.searchParams.get('resource')).toBe('http://127.0.0.1:3000');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(deriveCodeChallenge(request.codeVerifier));
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(request.state.length).toBeGreaterThanOrEqual(16);
    expect(request.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('produces a fresh state and verifier for every authorization request', async () => {
    const { client } = oidc(async () => json(DISCOVERY));
    const first = await client.createAuthorizationRequest();
    const second = await client.createAuthorizationRequest();
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });

  it('refuses a discovery document that points endpoints away from the issuer origin', async () => {
    const { client } = oidc(async () => json({ ...DISCOVERY, authorization_endpoint: 'https://evil.example.com/auth' }));
    await expect(client.createAuthorizationRequest()).rejects.toThrow(/issuer/i);
  });

  it('refuses a discovery document whose issuer does not match the configured issuer', async () => {
    const { client } = oidc(async () => json({ ...DISCOVERY, issuer: 'http://127.0.0.1:9999' }));
    await expect(client.createAuthorizationRequest()).rejects.toThrow(/issuer/i);
  });

  it('exchanges the code with the verifier and the pinned resource, returning an expiry', async () => {
    const { client, fetchImpl } = oidc(async (url) =>
      url.endsWith('/token')
        ? json({ access_token: 'at', token_type: 'Bearer', expires_in: 300 })
        : json(DISCOVERY),
    );

    const tokens = await client.exchangeAuthorizationCode({ code: 'the-code', codeVerifier: 'the-verifier' });
    expect(tokens).toEqual({ accessToken: 'at', expiresInSeconds: 300 });

    const call = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/token'));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    const body = new URLSearchParams(String(init.body));
    expect(init.method).toBe('POST');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('pharmacart-web-local');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:3001/auth/callback');
    expect(body.get('resource')).toBe('http://127.0.0.1:3000');
    expect(body.get('client_secret')).toBeNull();
  });

  it('refuses a token response without a bearer access token or a usable expiry', async () => {
    const cases = [
      { access_token: 'at', token_type: 'Bearer' },
      { access_token: '', token_type: 'Bearer', expires_in: 300 },
      { access_token: 'at', token_type: 'mac', expires_in: 300 },
      { access_token: 'at', token_type: 'Bearer', expires_in: 0 },
    ];
    for (const payload of cases) {
      const { client } = oidc(async (url) => (url.endsWith('/token') ? json(payload) : json(DISCOVERY)));
      await expect(client.exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v' })).rejects.toThrow();
    }
  });

  it('surfaces a token endpoint error instead of pretending the login succeeded', async () => {
    const { client } = oidc(async (url) =>
      url.endsWith('/token') ? json({ error: 'invalid_grant' }, 400) : json(DISCOVERY),
    );
    await expect(client.exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v' })).rejects.toThrow(/invalid_grant/);
  });

  it('refuses to be constructed with a non-loopback issuer', () => {
    expect(() =>
      createOidcClient({
        issuer: 'https://sso.example.com',
        clientId: 'pharmacart-web-local',
        redirectUri: 'http://127.0.0.1:3001/auth/callback',
        resource: 'http://127.0.0.1:3000',
      }),
    ).toThrow();
  });
});

/**
 * Pins the deliberate absence of a nonce.
 *
 * A nonce binds an ID token to one login attempt. This client consumes no ID token: the subject the
 * app displays comes from the API's `/v1/context`, which the API derives from the `sub` of an access
 * token it verified itself (packages/auth/src/verify-access-token.ts). Sending a nonce nothing checks
 * would assert a binding nothing enforces. The authorization code is bound by PKCE and by state held
 * on the server, which is what OAuth 2.1 relies on for a code flow.
 *
 * If an ID token is ever consumed here, a nonce must be sent and verified against it at the same
 * time, along with iss, aud, exp and the signature. The second test fails the moment an ID token
 * starts reaching the caller, which is the signal to do that work.
 */
describe('ID tokens and the nonce decision', () => {
  const TOKEN_RESPONSE = {
    access_token: 'synthetic-access-token',
    token_type: 'Bearer',
    expires_in: 300,
    id_token: 'synthetic.id.token',
    scope: 'openid pharmacart',
  };

  it('sends no nonce, because no ID token is consumed', async () => {
    const { client } = oidc(async () => json(DISCOVERY));
    const request = await client.createAuthorizationRequest();
    const params = new URL(request.url).searchParams;
    expect(params.has('nonce')).toBe(false);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe(request.state);
  });

  it('carries no ID token out of the token exchange', async () => {
    const { client } = oidc(async (url) => (url.endsWith('/token') ? json(TOKEN_RESPONSE) : json(DISCOVERY)));
    const tokens = await client.exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v' });
    expect(Object.keys(tokens).sort()).toEqual(['accessToken', 'expiresInSeconds']);
    expect(JSON.stringify(tokens)).not.toContain('synthetic.id.token');
  });
});
