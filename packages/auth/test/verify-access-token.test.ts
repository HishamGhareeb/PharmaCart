import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';

import { createAccessTokenVerifier } from '../src/verify-access-token.ts';

describe('access token verification', () => {
  let issuer: string;
  let server: Server;
  let privateKey: CryptoKey;

  before(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);

    server = createServer((request, response) => {
      if (request.url !== '/jwks') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: 'RS256', kid: 'local-test', use: 'sig' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    issuer = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function token(overrides: {
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    subject?: string;
    typ?: string;
    issuedAt?: boolean;
  } = {}): Promise<string> {
    let jwt = new SignJWT({ scope: 'openid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-test', typ: overrides.typ ?? 'at+jwt' })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? 'pharmacart-api')
      .setExpirationTime(overrides.expiresIn ?? '5m');
    if (overrides.subject !== '') jwt = jwt.setSubject(overrides.subject ?? 'synthetic-member-001');
    if (overrides.issuedAt !== false) jwt = jwt.setIssuedAt();
    return jwt.sign(privateKey);
  }

  it('returns a minimal verified principal for a valid RS256 access token', async () => {
    const verifier = createAccessTokenVerifier({
      issuer,
      audience: 'pharmacart-api',
      jwksUri: `${issuer}/jwks`,
    });

    const result = await verifier.verifyAccessToken(await token());

    assert.equal(result.subject, 'synthetic-member-001');
    assert.equal(result.issuer, issuer);
    assert.equal(result.claims.scope, 'openid');
  });

  for (const [name, overrides] of [
    ['expired', { expiresIn: -1 }],
    ['wrong issuer', { issuer: 'https://wrong.example.test' }],
    ['wrong audience', { audience: 'another-api' }],
    ['missing subject', { subject: '' }],
    ['missing issued-at', { issuedAt: false }],
    ['ID token type', { typ: 'JWT' }],
  ] as const) {
    it(`rejects a token with ${name}`, async () => {
      const verifier = createAccessTokenVerifier({ issuer, audience: 'pharmacart-api', jwksUri: `${issuer}/jwks` });
      await assert.rejects(verifier.verifyAccessToken(await token(overrides)));
    });
  }

  it('rejects an unsigned token', async () => {
    const verifier = createAccessTokenVerifier({ issuer, audience: 'pharmacart-api', jwksUri: `${issuer}/jwks` });
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: issuer, aud: 'pharmacart-api', sub: 'synthetic-member-001', iat: now, exp: now + 300 })).toString('base64url'),
      '',
    ].join('.');

    await assert.rejects(verifier.verifyAccessToken(unsigned));
  });

  it('rejects configuration without an explicit JWKS endpoint', () => {
    assert.throws(() => createAccessTokenVerifier({ issuer, audience: 'pharmacart-api', jwksUri: '' }));
  });
});
