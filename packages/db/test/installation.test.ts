import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ids, sql, resetDatabase } from './support.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';

// AC-016 partial evidence: installation lifecycle enforced on the authenticated
// inventory request path against real OIDC tokens and real PostgreSQL.
// Connector health and queue state are out of scope here; AC-016 stays NOT RUN.

const installationB = '50000000-0000-4000-8000-000000000002';
const connectorA = 'synthetic:connector:a';
// Reuse a subject issued by the local synthetic OIDC provider and pair it to B.
const connectorB = 'synthetic:user:b';
const advisoryLockKey = 916016;

const partition = (eventId: string, snapshotId: string, sequence: number, quantity: string) => ({
  kind: 'partition', eventId, snapshotId, sequence, partitionId: 'p1',
  rows: [{ sourceCode: '00017', quantity, unit: 'box' }],
});

const counts = async (installation: string) =>
  (await sql(`SELECT (SELECT count(*) FROM inventory_inbox WHERE installation_id='${installation}')::text || '|' ||
    (SELECT count(*) FROM inventory_projection WHERE installation_id='${installation}')::text || '|' ||
    (SELECT coalesce(max(revision),0) FROM inventory_state WHERE installation_id='${installation}')::text`)).trim();

const setStatus = (installation: string, status: string, reason: string | null = null) =>
  sql(`UPDATE connector_installation SET status='${status}', status_changed_at=now(),
    status_reason=${reason === null ? 'NULL' : `'${reason}'`} WHERE id='${installation}'`);

test('AC-016: pending, suspended and revoked installations are denied on their next inventory request', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status) VALUES
    ('${ids.installation}','${ids.a}','${ids.branchA}','${connectorA}','pending'),
    ('${installationB}','${ids.b}','${ids.branchB}','${connectorB}','active')`);
  const verifier = createAccessTokenVerifier({ issuer: identity.issuer, audience: 'pharmacart-api', jwksUri: `${identity.issuer}/jwks` });
  const app = buildTenantApi(pool, verifier);
  try {
    const { access_token: tokenA } = await identity.token(connectorA);
    const headers = { authorization: `Bearer ${tokenA}` };
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/inventory', headers, payload: payload as object });

    // Pairing is not confirmed: no pairing instant is invented for the stored row.
    assert.equal((await sql(`SELECT paired_at IS NULL FROM connector_installation WHERE id='${ids.installation}'`)).trim(), 't');
    const pending = await post(partition('event-1', 'snap-1', 1, '8'));
    assert.equal(pending.statusCode, 403);
    assert.equal(pending.json().error.code, 'INSTALLATION_DENIED');
    assert.doesNotMatch(pending.body, /pending|pairing|status|installation_id|50000000/i);
    assert.equal(await counts(ids.installation), '0|0|0');

    // Pairing confirmed.
    await sql(`UPDATE connector_installation SET status='active', paired_at=now(), status_changed_at=now() WHERE id='${ids.installation}'`);
    assert.equal((await post(partition('event-1', 'snap-1', 1, '8'))).statusCode, 202);
    assert.equal((await post({ kind: 'complete', eventId: 'event-2', snapshotId: 'snap-1', sequence: 1, expectedPartitionIds: ['p1'] })).statusCode, 202);
    assert.equal(await counts(ids.installation), '2|1|1');

    // Suspended: the agent keeps its durable queue, the server refuses the write.
    await setStatus(ids.installation, 'suspended', 'synthetic-maintenance');
    const suspended = await post(partition('event-3', 'snap-2', 2, '7'));
    assert.equal(suspended.statusCode, 403);
    assert.equal(suspended.json().error.code, 'INSTALLATION_DENIED');
    assert.equal(await counts(ids.installation), '2|1|1');

    // Resumed: the same queued event is now accepted.
    await setStatus(ids.installation, 'active');
    assert.equal((await post(partition('event-3', 'snap-2', 2, '7'))).statusCode, 202);
    assert.equal(await counts(ids.installation), '3|1|1');

    // Revoked: denied, and nothing queued under the revoked identity is accepted.
    await setStatus(ids.installation, 'revoked', 'synthetic-stolen-laptop');
    const revoked = await post(partition('event-4', 'snap-3', 3, '6'));
    assert.equal(revoked.statusCode, 403);
    assert.equal(revoked.json().error.code, 'INSTALLATION_DENIED');
    assert.equal((await post({ kind: 'complete', eventId: 'event-5', snapshotId: 'snap-2', sequence: 2, expectedPartitionIds: ['p1'] })).statusCode, 403);
    assert.equal(await counts(ids.installation), '3|1|1');

    // Revocation is terminal: the database refuses resurrection in any direction.
    for (const status of ['active', 'pending', 'suspended']) {
      await assert.rejects(setStatus(ids.installation, status), /terminal|revocation/i, `resurrection to ${status} was accepted`);
    }
    assert.equal((await sql(`SELECT status FROM connector_installation WHERE id='${ids.installation}'`)).trim(), 'revoked');
    assert.equal((await post(partition('event-6', 'snap-3', 3, '6'))).statusCode, 403);
    assert.equal(await counts(ids.installation), '3|1|1');

    // A revoked row still accepts non-resurrecting maintenance.
    await setStatus(ids.installation, 'revoked', 'synthetic-stolen-laptop-confirmed');
    assert.equal((await sql(`SELECT status_reason FROM connector_installation WHERE id='${ids.installation}'`)).trim(), 'synthetic-stolen-laptop-confirmed');

    // The lookup binds one authenticated subject to its own stored scope only.
    assert.equal((await sql(`SELECT count(*) FROM pharmacart_installation_lifecycle('${connectorA}')`)).trim(), '1');
    assert.equal((await sql(`SELECT id FROM pharmacart_installation_lifecycle('${connectorA}')`)).trim(), ids.installation);
    assert.equal((await sql(`SELECT count(*) FROM pharmacart_installation_lifecycle('synthetic:user:a')`)).trim(), '0');
    assert.equal((await sql(`SELECT count(*) FROM connector_installation`)).trim(), '2');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});

test('AC-016: a connector token cannot borrow another installation scope', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status,paired_at,status_changed_at) VALUES
    ('${ids.installation}','${ids.a}','${ids.branchA}','${connectorA}','active',now(),now()),
    ('${installationB}','${ids.b}','${ids.branchB}','${connectorB}','revoked',now(),now())`);
  const verifier = createAccessTokenVerifier({ issuer: identity.issuer, audience: 'pharmacart-api', jwksUri: `${identity.issuer}/jwks` });
  const app = buildTenantApi(pool, verifier);
  try {
    const tokenA = (await identity.token(connectorA)).access_token;
    const tokenB = (await identity.token(connectorB)).access_token;
    const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/v1/inventory',
      headers: { authorization: `Bearer ${token}` }, payload: payload as object });

    // A caller cannot name a scope: a forged installation identifier is off contract.
    assert.equal((await post(tokenA, { ...partition('forged', 'snap-1', 1, '8'), installationId: installationB })).statusCode, 400);
    // Tenant selectors on the request do not move the write either.
    const spoofed = await app.inject({ method: 'POST', url: '/v1/inventory',
      headers: { authorization: `Bearer ${tokenA}`, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB },
      payload: partition('event-1', 'snap-1', 1, '8') });
    assert.equal(spoofed.statusCode, 202);
    assert.equal((await sql(`SELECT organisation_id::text || '|' || branch_id::text FROM inventory_inbox`)).trim(), `${ids.a}|${ids.branchA}`);

    // The revoked installation B is denied even though A is active in the same table.
    assert.equal((await post(tokenB, partition('event-2', 'snap-1', 1, '4'))).statusCode, 403);
    // A subject with a membership but no installation is denied.
    assert.equal((await post((await identity.token('synthetic:user:a')).access_token, partition('event-3', 'snap-1', 1, '4'))).statusCode, 403);
    // One partition of an incomplete snapshot: inbox only, no projection yet.
    assert.equal(await counts(installationB), '0|0|0');
    assert.equal(await counts(ids.installation), '1|0|0');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});

test('AC-016: an in-flight revocation serialises against the inventory request', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status,paired_at,status_changed_at)
    VALUES('${ids.installation}','${ids.a}','${ids.branchA}','${connectorA}','active',now(),now())`);
  const verifier = createAccessTokenVerifier({ issuer: identity.issuer, audience: 'pharmacart-api', jwksUri: `${identity.issuer}/jwks` });
  const app = buildTenantApi(pool, verifier);
  try {
    const headers = { authorization: `Bearer ${(await identity.token(connectorA)).access_token}` };
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/inventory', headers, payload: payload as object });
    assert.equal((await post(partition('event-1', 'snap-1', 1, '8'))).statusCode, 202);
    assert.equal((await post({ kind: 'complete', eventId: 'event-1c', snapshotId: 'snap-1', sequence: 1, expectedPartitionIds: ['p1'] })).statusCode, 202);
    assert.equal(await counts(ids.installation), '2|1|1');

    // The revoking transaction holds the installation row while the next request arrives.
    const revoking = sql(`BEGIN;
      UPDATE connector_installation SET status='revoked', status_reason='synthetic-stolen-laptop', status_changed_at=now()
        WHERE id='${ids.installation}';
      SELECT pg_advisory_xact_lock(${advisoryLockKey});
      SELECT pg_sleep(3);
      COMMIT;`);
    for (let attempt = 0; ; attempt += 1) {
      if ((await sql(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=${advisoryLockKey} AND granted`)).trim() === '1') break;
      assert(attempt < 20, 'the revoking transaction never took its marker lock');
      await delay(100);
    }
    const denied = await post(partition('event-2', 'snap-2', 2, '7'));
    await revoking;
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'INSTALLATION_DENIED');
    assert.equal(await counts(ids.installation), '2|1|1');
    assert.equal((await post(partition('event-3', 'snap-2', 2, '7'))).statusCode, 403);
    assert.equal(await counts(ids.installation), '2|1|1');

    // Least privilege: the runtime may execute the lookup and may not write status.
    const acl = (await sql(`SELECT coalesce(array_to_string(proacl,','),'') FROM pg_proc WHERE proname='pharmacart_installation_lifecycle'`)).trim();
    assert.match(acl, /pharmacart_runtime=X\//);
    assert.doesNotMatch(acl, /(^|,)=X\//);
    assert.equal((await sql(`SELECT prosecdef::text || '|' || array_to_string(proconfig,',') FROM pg_proc WHERE proname='pharmacart_installation_lifecycle'`)).trim(), 'true|search_path=pg_catalog');
    assert.equal((await sql(`SELECT has_table_privilege('pharmacart_runtime','connector_installation','SELECT')::text || '|' ||
      has_table_privilege('pharmacart_runtime','connector_installation','UPDATE')::text || '|' ||
      has_table_privilege('pharmacart_runtime','connector_installation','INSERT')::text || '|' ||
      has_table_privilege('pharmacart_runtime','connector_installation','DELETE')::text`)).trim(), 'true|false|false|false');
    assert.match((await sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='connector_installation_status_check'`)).trim(), /pending.*suspended|suspended.*pending/);
    assert.equal((await sql(`SELECT count(*) FROM pg_proc WHERE proname LIKE 'pharmacart_installation%'`)).trim(), '1');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});
