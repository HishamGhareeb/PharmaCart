import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { ids, resetDatabase, sql } from './support.ts';

// Synthetic identifiers for a second authorised branch of organisation A. The shared fixtures stay untouched.
const second = {
  branch: '20000000-0000-4000-8000-000000000003',
  need: '40000000-0000-4000-8000-000000000003',
  map: '70000000-0000-4000-8000-000000000003',
  relationship: '80000000-0000-4000-8000-000000000003',
  offer: '90000000-0000-4000-8000-000000000003',
  product: '60000000-0000-4000-8000-000000000001',
};

// The same synthetic member is authorised in both branches, so the refusal below is a key-scope decision only.
async function seedSecondBranch() {
  await sql(`INSERT INTO branch(id,organisation_id,name,timezone) VALUES('${second.branch}','${ids.a}','A2','Asia/Bahrain');
    INSERT INTO membership_branch VALUES('${ids.a}','${ids.memberA}','${second.branch}');
    INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity) VALUES('${second.need}','${ids.a}','${second.branch}','SYN-A2',2);
    INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES('${second.map}','${ids.a}','${second.branch}','${second.product}','verified',1);
    UPDATE need SET source_map_id='${second.map}' WHERE id='${second.need}';
    INSERT INTO supplier_relationship(id,organisation_id,branch_id,supplier_id,status,terms_version) VALUES('${second.relationship}','${ids.a}','${second.branch}','${ids.supplier}','active',1);
    INSERT INTO account_offer(id,organisation_id,branch_id,relationship_id,product_id,unit,unit_price,currency,version,terms_version,expires_at)
    VALUES('${second.offer}','${ids.a}','${second.branch}','${second.relationship}','${second.product}','box',12.35,'EGP',1,1,now()+interval '1 hour');
    INSERT INTO budget(organisation_id,branch_id,currency,period,limit_amount,reserved_amount)
    VALUES('${ids.a}','${second.branch}','EGP',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),100,0);`);
}

test('partial approval subtracts the exact quoted quantity, keeps the remainder open and never subtracts on replay', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  const app = buildTenantApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement(); const { access_token: token } = await identity.token();
    const headers = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const quote = (needVersion: number, quantity: string) => app.inject({ method: 'POST', url: '/v1/quotes', headers,
      payload: { branchId: ids.branchA, lines: [{ needId: ids.needA, needVersion, quantity, unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } } });
    const approve = (id: string, key: string) => app.inject({ method: 'POST', url: `/v1/quotes/${id}/approve`,
      headers: { ...headers, 'idempotency-key': key }, payload: { quoteVersion: 1 } });
    const needState = async () => (await sql(`SELECT status||'|'||version||'|'||requested_quantity::text FROM need WHERE id='${ids.needA}'`)).trim();
    const approvals = async () => (await sql('SELECT count(*) FROM approval')).trim();

    // The synthetic need requests two boxes. Two competing quotes each cover one box at the same need version.
    const first = await quote(1, '1'); assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().total, '12.35');
    const competing = await quote(1, '1'); assert.equal(competing.statusCode, 201, competing.body);
    assert.equal(await needState(), 'open|1|2');

    // Only one of two concurrent approvals of the same need version may win; the loser must refuse, not double-spend.
    const race = await Promise.all([approve(first.json().id, 'race-a'), approve(competing.json().id, 'race-b')]);
    const evidence = race.map(reply => `${reply.statusCode} ${reply.body}`).join('\n');
    assert.equal(race.filter(reply => reply.statusCode === 202).length, 1, evidence);
    const loser = race.find(reply => reply.statusCode === 409);
    assert(loser, evidence); assert.equal(loser.json().error.code, 'REQUOTE_REQUIRED');
    // One box approved, one box still outstanding, version incremented by exactly one.
    assert.equal(await needState(), 'open|2|1');
    assert.equal(await approvals(), '1');
    assert.equal((await sql('SELECT reserved_amount=12.35 FROM budget')).trim(), 't');

    // Replaying the winning key returns the stored result and subtracts nothing further.
    const winner = race.findIndex(reply => reply.statusCode === 202);
    const winningQuote = [first, competing][winner].json().id as string;
    const replay = await approve(winningQuote, ['race-a', 'race-b'][winner]);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.deepEqual(replay.json(), race[winner].json());
    assert.equal(await needState(), 'open|2|1');
    assert.equal(await approvals(), '1');
    assert.equal((await sql('SELECT reserved_amount=12.35 FROM budget')).trim(), 't');

    // A new quote may only ask for the outstanding remainder.
    const excessive = await quote(2, '2');
    assert.equal(excessive.statusCode, 422, excessive.body);
    assert.equal(excessive.json().error.code, 'QUANTITY_EXCEEDS_NEED');
    const remainder = await quote(2, '1'); assert.equal(remainder.statusCode, 201, remainder.body);

    // A remainder that shrinks without a version change must still be caught by the revalidation under the approval lock.
    await sql(`UPDATE need SET requested_quantity=0.5 WHERE id='${ids.needA}'`);
    const shrunk = await approve(remainder.json().id, 'shrunk-remainder');
    assert.equal(shrunk.statusCode, 409, shrunk.body);
    assert.equal(shrunk.json().error.code, 'REQUOTE_REQUIRED');
    assert.equal(await needState(), 'open|2|0.5');
    assert.equal(await approvals(), '1');
    assert.equal((await sql("SELECT count(*) FROM command_result WHERE key='shrunk-remainder'")).trim(), '0');

    // Covering the remainder exactly closes the need without ever storing a forbidden zero quantity.
    await sql(`UPDATE need SET requested_quantity=1 WHERE id='${ids.needA}'`);
    const covered = await approve(remainder.json().id, 'remainder');
    assert.equal(covered.statusCode, 202, covered.body);
    assert.equal(await needState(), 'covered|3|1');
    assert.equal(await approvals(), '2');
    assert.equal((await sql('SELECT count(*) FROM order_intent')).trim(), '2');
    assert.equal((await sql('SELECT reserved_amount=24.70 FROM budget')).trim(), 't');
    assert.equal((await sql('SELECT count(*) FROM need WHERE requested_quantity<=0')).trim(), '0');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});

test('an organisation-scoped idempotency key reused by another authorised branch is refused without mutation or disclosure', async () => {
  const pool = await resetDatabase(); const identity = await localIdentity();
  const app = buildTenantApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement(); await seedSecondBranch(); const { access_token: token } = await identity.token();
    const headersA = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const headersB = { ...headersA, 'x-branch-id': second.branch };
    const quote = (headers: typeof headersA, branchId: string, needId: string) => app.inject({ method: 'POST', url: '/v1/quotes', headers,
      payload: { branchId, lines: [{ needId, needVersion: 1, quantity: '2', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } } });
    const approve = (headers: typeof headersA, id: string, key: string) => app.inject({ method: 'POST', url: `/v1/quotes/${id}/approve`,
      headers: { ...headers, 'idempotency-key': key }, payload: { quoteVersion: 1 } });

    const quoteA = await quote(headersA, ids.branchA, ids.needA); assert.equal(quoteA.statusCode, 201, quoteA.body);
    const approvedA = await approve(headersA, quoteA.json().id, 'shared-key');
    assert.equal(approvedA.statusCode, 202, approvedA.body);
    const quoteB = await quote(headersB, second.branch, second.need); assert.equal(quoteB.statusCode, 201, quoteB.body);

    // The stored result of branch A is invisible to branch B, but the key is organisation-scoped: refuse deliberately.
    const collision = await approve(headersB, quoteB.json().id, 'shared-key');
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal(collision.json().error.code, 'IDEMPOTENCY_KEY_SCOPE_CONFLICT');
    assert.doesNotMatch(collision.body, new RegExp(approvedA.json().approvalId as string));
    assert.doesNotMatch(collision.body, new RegExp(quoteA.json().id as string));
    assert.doesNotMatch(collision.body, /approvalId|orderIntentIds|pc-syn-|branch/i);

    // Nothing moved in either branch.
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(), '1');
    assert.equal((await sql('SELECT count(*) FROM budget_reservation')).trim(), '1');
    assert.equal((await sql('SELECT count(*) FROM order_intent')).trim(), '1');
    assert.equal((await sql('SELECT count(*) FROM command_result')).trim(), '1');
    assert.equal((await sql('SELECT count(*) FROM procurement_outbox')).trim(), '2');
    assert.equal((await sql(`SELECT count(*) FROM budget WHERE branch_id='${second.branch}' AND reserved_amount=0`)).trim(), '1');
    assert.equal((await sql(`SELECT status||'|'||version FROM need WHERE id='${second.need}'`)).trim(), 'open|1');
    assert.equal((await sql(`SELECT status FROM quote WHERE id='${quoteB.json().id}'`)).trim(), 'quoted');

    // Canonical same-branch replay is unchanged by the refusal.
    const replayA = await approve(headersA, quoteA.json().id, 'shared-key');
    assert.equal(replayA.statusCode, 202, replayA.body);
    assert.deepEqual(replayA.json(), approvedA.json());

    // The second branch remains able to approve under a key of its own.
    const approvedB = await approve(headersB, quoteB.json().id, 'second-branch-key');
    assert.equal(approvedB.statusCode, 202, approvedB.body);
    assert.notEqual(approvedB.json().approvalId, approvedA.json().approvalId);
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(), '2');
    assert.equal((await sql('SELECT count(*) FROM command_result')).trim(), '2');
    assert.equal((await sql(`SELECT count(*) FROM budget WHERE branch_id='${second.branch}' AND reserved_amount=24.70`)).trim(), '1');
    assert.equal((await sql(`SELECT status||'|'||version FROM need WHERE id='${second.need}'`)).trim(), 'covered|2');
  } finally { await app.close(); await pool.end(); await identity.close(); }
});
