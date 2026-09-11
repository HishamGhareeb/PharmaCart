import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestInventory } from '../src/inventory.ts';
import { ids, sql, resetDatabase } from './support.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';

test('AC-003/004: authenticated durable replay and incomplete snapshots preserve prior stock', async () => {
  assert.equal(typeof ingestInventory, 'function');
  const pool = await resetDatabase(); const identity = await localIdentity();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status)
    VALUES ('${ids.installation}','${ids.a}','${ids.branchA}','synthetic:connector:a','active')`);
  const verifier = createAccessTokenVerifier({ issuer: identity.issuer, audience: 'pharmacart-api', jwksUri: `${identity.issuer}/jwks` });
  let app = buildTenantApi(pool, verifier);
  try {
    const { access_token: token } = await identity.token('synthetic:connector:a');
    const headers = { authorization: `Bearer ${token}` };
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/inventory', headers, payload: payload as object });
    const part = { kind:'partition', eventId:'event-1', snapshotId:'snap-1', sequence:1, partitionId:'p1', rows:[{ sourceCode:'00017', quantity:'8', unit:'box' }] };
    assert.equal((await post(part)).statusCode, 202);
    assert.equal((await post({kind:'complete',eventId:'event-2',snapshotId:'snap-1',sequence:1,expectedPartitionIds:['p1']})).statusCode, 202);
    await app.close(); app = buildTenantApi(pool, verifier);
    const replay = await Promise.all([post(part), post(part)]);
    assert(replay.every(r => r.statusCode === 202));
    assert.equal((await sql('SELECT count(*) FROM inventory_inbox')).trim(), '2');
    assert.equal((await sql('SELECT revision FROM inventory_state')).trim(), '1');
    assert.equal((await sql('SELECT count(*) FROM need')).trim(), '2');
    assert.equal((await sql('SELECT count(*) FROM inventory_alert')).trim(), '0');
    assert.equal((await post({ ...part, rows:[{sourceCode:'00017',quantity:'9',unit:'box'}] })).statusCode, 409);
    assert.equal((await post({ ...part, eventId:'event-3', snapshotId:'snap-2', sequence:2, rows:[{sourceCode:'00018',quantity:'4',unit:'box'}] })).statusCode, 202);
    assert.equal((await post({kind:'complete',eventId:'event-4',snapshotId:'snap-2',sequence:2,expectedPartitionIds:['p1','p2']})).statusCode, 202);
    assert.equal((await sql("SELECT quantity::text || '|' || stale FROM inventory_projection WHERE source_code='00017'")).trim(), '8|true');
    assert.equal((await sql('SELECT revision FROM inventory_state')).trim(), '1');
    assert.equal((await post({ ...part, eventId:'forged', installationId:ids.installation })).statusCode, 400);
    await sql(`UPDATE connector_installation SET status='revoked' WHERE id='${ids.installation}'`);
    assert.equal((await post(part)).statusCode, 403);
    assert.equal((await sql('SELECT count(*) FROM inventory_inbox')).trim(), '4');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});
