import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLocalOidcProvider } from './provider.ts';

describe('local OIDC provider', () => {
  it('exposes OIDC discovery for the synthetic PKCE client', async () => {
    const provider = await createLocalOidcProvider({ issuer: 'http://127.0.0.1:55433' });
    assert.equal(provider.issuer, 'http://127.0.0.1:55433');
    const client = await provider.Client.find('pharmacart-local');
    assert(client);
    assert.deepEqual(client.redirectUris, ['http://127.0.0.1:3000/auth/callback']);
    assert.equal(client.tokenEndpointAuthMethod, 'none');
  });

  it('refuses non-loopback issuers', async () => {
    await assert.rejects(createLocalOidcProvider({ issuer: 'https://identity.example.com' }));
  });

  it('refuses to run in production mode', async () => {
    await assert.rejects(createLocalOidcProvider({ issuer: 'http://127.0.0.1:55433', environment: 'production' }));
  });
});
