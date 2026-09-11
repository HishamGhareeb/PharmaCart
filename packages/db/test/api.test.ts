import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { ids, sql, resetDatabase } from './support.ts';

test('AC-001: real OIDC and PostgreSQL API deny foreign private needs without disclosure', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  const verifier = createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' });
  const app = buildTenantApi(pool, verifier);
  try {
    const { access_token: token } = await identity.token();
    const headers = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const own = await app.inject({ url: `/v1/needs/${ids.needA}`, headers });
    assert.equal(own.statusCode, 200); assert.equal(own.json().productRef, 'SYN-A');
    const foreign = await app.inject({ url: `/v1/needs/${ids.needB}`, headers });
    assert.equal(foreign.statusCode, 404); assert.doesNotMatch(foreign.body, /SYN-B|productRef|quantity/);
    const nonexistent = await app.inject({ url: '/v1/needs/ffffffff-ffff-4fff-8fff-ffffffffffff', headers });
    assert.deepEqual(foreign.json().error.code, nonexistent.json().error.code);
    assert.equal((await app.inject({ url: `/v1/needs/${ids.needA}` })).statusCode, 401);
    assert.equal((await app.inject({ url: `/v1/needs/${ids.needB}`, headers: { ...headers, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB } })).statusCode, 403);
    await sql(`UPDATE membership SET status='revoked' WHERE id='${ids.memberA}'`);
    assert.equal((await app.inject({ url: `/v1/needs/${ids.needA}`, headers })).statusCode, 403);
    await sql(`UPDATE membership SET status='active' WHERE id='${ids.memberA}'; DELETE FROM membership_branch WHERE membership_id='${ids.memberA}'`);
    assert.equal((await app.inject({ url: `/v1/needs/${ids.needA}`, headers })).statusCode, 403);
    assert.equal((await sql(`SELECT count(*) FROM need`)).trim(), '2');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});
