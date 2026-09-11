import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localIdentity } from './local-identity.ts';
import { createAccessTokenVerifier } from '../src/verify-access-token.ts';

test('local OIDC authorization code with PKCE yields a verifiable API access token', async () => {
  const identity = await localIdentity();
  try {
    const discovery = await fetch(`${identity.issuer}/.well-known/openid-configuration`).then(r => r.json()) as { jwks_uri: string };
    const verifier = createAccessTokenVerifier({ issuer: identity.issuer, audience: 'pharmacart-api', jwksUri: discovery.jwks_uri });
    const tokens = await identity.token();
    assert.equal((await verifier.verifyAccessToken(tokens.access_token)).subject, 'synthetic:user:a');
    await assert.rejects(verifier.verifyAccessToken(tokens.id_token));
  } finally { await identity.close(); }
});
