// AWAITING COORDINATOR EXECUTION. These cases need the shared pharmacart_test database, migration
// 0015 and Docker, all of which the coordinator serialises. This builder wrote them first and did
// not run them; no acceptance criterion may move on their strength until the coordinator does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { buildTenantApi, type TokenVerifier } from '../../../apps/api/src/tenant-api.ts';
import { MAX_MAPPING_CANDIDATES } from '../src/mapping.ts';
import { withTransaction } from '../src/runtime.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { ids, resetDatabase, sql } from './support.ts';

const mappingIds = {
  purchaser: '30000000-0000-4000-8000-000000000003',
  needC: '40000000-0000-4000-8000-000000000003',
  needD: '40000000-0000-4000-8000-000000000004',
  needE: '40000000-0000-4000-8000-000000000005',
  installation: '50000000-0000-4000-8000-000000000009',
  product1: '60000000-0000-4000-8000-000000000001',
  product2: '60000000-0000-4000-8000-000000000002',
  incomplete: '60000000-0000-4000-8000-000000000003',
  unverified: '60000000-0000-4000-8000-000000000004',
  strip: '60000000-0000-4000-8000-000000000005',
};
const OWNER_SUBJECT = 'synthetic:user:a';
// Reuse an allowed local OIDC subject; membership in A is separate from its B scope.
const PURCHASER_SUBJECT = 'synthetic:user:b';
/** Never inserted: used both as a missing need and as a missing catalogue pack. */
const ABSENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/**
 * Adds a purchaser in the same branch as the owner, two catalogue packs that must never be
 * selectable, one pack sold by the strip, and three unmapped needs: one without authoritative unit
 * metadata and two whose connector target states a unit.
 */
async function seedMappingFixture() {
  await sql(`INSERT INTO membership(id,organisation_id,user_subject,role,status) VALUES
    ('${mappingIds.purchaser}','${ids.a}','${PURCHASER_SUBJECT}','purchaser','active');
    INSERT INTO membership_branch VALUES ('${ids.a}','${mappingIds.purchaser}','${ids.branchA}');
    INSERT INTO procurement_product(id,identity,status) VALUES
    ('${mappingIds.incomplete}','{"brand":"SYN Brand","strength":"5 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','verified'),
    ('${mappingIds.unverified}','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"15 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','review'),
    ('${mappingIds.strip}','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"5 mg","dosageForm":"tablet","packSize":{"value":"10","unit":"tablet"},"saleUnit":"strip"}','verified');
    INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status) VALUES
    ('${mappingIds.installation}','${ids.a}','${ids.branchA}','synthetic:connector:mapping','active');
    INSERT INTO inventory_target(installation_id,organisation_id,branch_id,source_code,product_ref,unit,target_quantity) VALUES
    ('${mappingIds.installation}','${ids.a}','${ids.branchA}','D-1','SYN-D','box',10),
    ('${mappingIds.installation}','${ids.a}','${ids.branchA}','E-1','SYN-E','strip',10);
    INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity,source_ref) VALUES
    ('${mappingIds.needC}','${ids.a}','${ids.branchA}','SYN-C',5,NULL),
    ('${mappingIds.needD}','${ids.a}','${ids.branchA}','SYN-D',4,'${mappingIds.installation}:D-1'),
    ('${mappingIds.needE}','${ids.a}','${ids.branchA}','SYN-E',4,'${mappingIds.installation}:E-1');`);
}

/**
 * buildTenantApi registers the mapping module itself, so these cases drive the production route tree
 * through the same authentication, tenant transaction and error plumbing. Registering the module a
 * second time would be refused as a duplicate route.
 */
function mappingApi(pool: Pool, verifier: TokenVerifier) {
  return buildTenantApi(pool, verifier);
}

/**
 * A provenance insert written directly through the runtime role, bypassing the repository. The
 * tenant columns are always the acting tenant's, so the row satisfies the tenant_scope WITH CHECK
 * and only the composite references can refuse it.
 */
const DECISION_INSERT = `INSERT INTO need_mapping_decision(
  id,organisation_id,branch_id,need_id,need_version,map_id,product_id,decided_by,decision,
  unit_basis,unit,supplied_unit,authoritative_unit,observed_candidate_count,observed_candidates_truncated)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,'explicit_human_selection','explicit_supplied_unit','box','box',NULL,1,false)`;

function insertDecisionAsTenantA(pool: Pool, needId: string, needVersion: number, mapId: string, productId: string) {
  return withTransaction(pool, OWNER_SUBJECT, ids.a, ids.branchA, (client) =>
    client.query(DECISION_INSERT,
      [randomUUID(), ids.a, ids.branchA, needId, needVersion, mapId, productId, ids.memberA]));
}

async function refusedDecision(pool: Pool, needId: string, needVersion: number, mapId: string, productId: string) {
  try {
    await insertDecisionAsTenantA(pool, needId, needVersion, mapId, productId);
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new assert.AssertionError({ message: 'the provenance insert was expected to be refused' });
}

const catalogueDigest = () =>
  sql("SELECT md5(string_agg(id::text || status || identity::text, '|' ORDER BY id)) FROM procurement_product");
const privilege = async (table: string, action: string) =>
  (await sql(`SELECT has_table_privilege('pharmacart_runtime','${table}','${action}')`)).trim();
const scalar = async (text: string) => (await sql(text)).trim();

test('AC-002 evidence: mapping candidates are bounded, tenant-scoped and always await an explicit human choice', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = mappingApi(pool, createAccessTokenVerifier({
    issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api',
  }));
  try {
    await seedProcurement();
    await seedMappingFixture();
    const { access_token: ownerToken } = await identity.token(OWNER_SUBJECT);
    const { access_token: purchaserToken } = await identity.token(PURCHASER_SUBJECT);
    const owner = { authorization: `Bearer ${ownerToken}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const purchaser = { authorization: `Bearer ${purchaserToken}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const candidates = (needId: string, headers: Record<string, string>) =>
      app.inject({ url: `/v1/needs/${needId}/mapping-candidates`, headers });

    // A need without authoritative unit metadata sees every verified, complete pack identity. Two
    // packs share a brand and differ only in strength, so the answer is ambiguous by construction.
    const withoutUnit = await candidates(mappingIds.needC, owner);
    assert.equal(withoutUnit.statusCode, 200, withoutUnit.body);
    const view = withoutUnit.json();
    assert.deepEqual(view.candidates.map((candidate: { productId: string }) => candidate.productId),
      [mappingIds.product1, mappingIds.product2, mappingIds.strip]);
    assert.deepEqual(view.candidates.map((candidate: { identity: { strength: string } }) => candidate.identity.strength),
      ['5 mg', '10 mg', '5 mg']);
    assert.equal(view.selectionRequired, true);
    assert.equal(view.ambiguous, true);
    assert.equal(view.authoritativeUnit, null);
    assert.equal(view.unitBasis, 'explicit_supplied_unit_required');
    assert.equal(view.currentProductId, null);
    assert.equal(view.truncated, false);
    // The verified pack with no manufacturer is withheld rather than partially trusted, and the
    // catalogue row still under review never enters the window.
    assert.equal(view.unselectableExcluded, 1);
    assert(view.candidates.length <= MAX_MAPPING_CANDIDATES);
    assert.doesNotMatch(withoutUnit.body, new RegExp(`${mappingIds.incomplete}|${mappingIds.unverified}`));
    // No account pricing, offer or supplier reaches a candidate list.
    assert.doesNotMatch(withoutUnit.body, /price|currency|EGP|offer|relationship|supplier/i);

    // Authoritative unit metadata narrows the list by exact unit equality; the strip pack is not
    // converted into a box and the box packs are not converted into strips.
    const boxes = await candidates(mappingIds.needD, owner);
    assert.equal(boxes.statusCode, 200, boxes.body);
    assert.equal(boxes.json().authoritativeUnit, 'box');
    assert.equal(boxes.json().unitBasis, 'authoritative_metadata');
    assert.deepEqual(boxes.json().candidates.map((candidate: { productId: string }) => candidate.productId),
      [mappingIds.product1, mappingIds.product2]);

    const strips = await candidates(mappingIds.needE, owner);
    assert.equal(strips.statusCode, 200, strips.body);
    assert.equal(strips.json().authoritativeUnit, 'strip');
    assert.deepEqual(strips.json().candidates.map((candidate: { productId: string }) => candidate.productId),
      [mappingIds.strip]);
    // One eligible candidate is still a decision for a person to take.
    assert.equal(strips.json().ambiguous, false);
    assert.equal(strips.json().selectionRequired, true);

    // A purchaser may read the same candidates and may not bind one.
    const purchaserRead = await candidates(mappingIds.needC, purchaser);
    assert.equal(purchaserRead.statusCode, 200, purchaserRead.body);
    assert.deepEqual(purchaserRead.json().candidates, withoutUnit.json().candidates);
    const purchaserWrite = await app.inject({
      method: 'POST', url: `/v1/needs/${mappingIds.needC}/mapping`, headers: purchaser,
      payload: { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'box' },
    });
    assert.equal(purchaserWrite.statusCode, 403, purchaserWrite.body);
    assert.equal(purchaserWrite.json().error.code, 'FORBIDDEN');

    // A foreign need is indistinguishable from one that does not exist, in code and in content.
    const foreign = await candidates(ids.needB, owner);
    const absent = await candidates(ABSENT_ID, owner);
    assert.equal(foreign.statusCode, 404);
    assert.equal(absent.statusCode, 404);
    assert.equal(foreign.json().error.code, absent.json().error.code);
    assert.equal(foreign.json().error.message, absent.json().error.message);
    assert.doesNotMatch(foreign.body, /SYN-B-PRIVATE|productRef|needVersion/);
    const foreignWrite = await app.inject({
      method: 'POST', url: `/v1/needs/${ids.needB}/mapping`, headers: owner,
      payload: { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'box' },
    });
    assert.equal(foreignWrite.statusCode, 404, foreignWrite.body);
    assert.doesNotMatch(foreignWrite.body, /SYN-B-PRIVATE/);

    assert.equal((await candidates(mappingIds.needC, { 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA })).statusCode, 401);
    // Reading candidates and refusing writes changed nothing.
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '0');
    assert.equal(await scalar(`SELECT count(*) FROM need WHERE source_map_id IS NOT NULL`), '1');
    assert.equal(await scalar(`SELECT version FROM need WHERE id='${mappingIds.needC}'`), '1');
  } finally {
    await app.close();
    await pool.end();
    await identity.close();
  }
});

test('AC-002 evidence: explicit binding refuses unverified, unit-inconsistent, stale and concurrent selections', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = mappingApi(pool, createAccessTokenVerifier({
    issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api',
  }));
  try {
    await seedProcurement();
    await seedMappingFixture();
    const before = await catalogueDigest();
    const { access_token: token } = await identity.token(OWNER_SUBJECT);
    const headers = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const bind = (needId: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/v1/needs/${needId}/mapping`, headers, payload });

    // Every refusal an ambiguous or unusable catalogue must produce, before anything is written.
    const refusals: readonly [Record<string, unknown>, number, string][] = [
      [{ needVersion: 1, productId: mappingIds.unverified, suppliedUnit: 'box' }, 422, 'CATALOGUE_UNVERIFIED'],
      [{ needVersion: 1, productId: ABSENT_ID, suppliedUnit: 'box' }, 422, 'CATALOGUE_UNVERIFIED'],
      [{ needVersion: 1, productId: mappingIds.incomplete, suppliedUnit: 'box' }, 422, 'CATALOGUE_IDENTITY_INCOMPLETE'],
      [{ needVersion: 1, productId: mappingIds.product1 }, 422, 'SUPPLIED_UNIT_REQUIRED'],
      [{ needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'strip' }, 422, 'UNIT_MISMATCH'],
      [{ needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'BOX' }, 422, 'UNIT_MISMATCH'],
      [{ needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'boxes' }, 422, 'UNIT_MISMATCH'],
      [{ needVersion: 2, productId: mappingIds.product1, suppliedUnit: 'box' }, 409, 'NEED_VERSION_CONFLICT'],
    ];
    for (const [payload, status, code] of refusals) {
      const response = await bind(mappingIds.needC, payload);
      assert.equal(response.statusCode, status, `${JSON.stringify(payload)} -> ${response.body}`);
      assert.equal(response.json().error.code, code, response.body);
    }
    assert.equal(await scalar(`SELECT version FROM need WHERE id='${mappingIds.needC}'`), '1');
    assert.equal(await scalar(`SELECT count(*) FROM need WHERE id='${mappingIds.needC}' AND source_map_id IS NULL`), '1');
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '0');

    // An explicit selection with a supplied unit matched to the catalogue sale unit is accepted and
    // provenanced with the number of packs that were eligible for this need at bind time.
    const bound = await bind(mappingIds.needC, { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'box' });
    assert.equal(bound.statusCode, 201, bound.body);
    const mapping = bound.json();
    assert.equal(mapping.productId, mappingIds.product1);
    assert.equal(mapping.needVersion, 2);
    assert.equal(mapping.unit, 'box');
    assert.equal(mapping.unitBasis, 'explicit_supplied_unit');
    assert.equal(mapping.mapStatus, 'verified');
    assert.equal(mapping.repeated, false);
    assert.equal(await scalar(`SELECT version FROM need WHERE id='${mappingIds.needC}'`), '2');
    assert.equal(await scalar(`SELECT source_map_id FROM need WHERE id='${mappingIds.needC}'`), mapping.mapId);
    assert.equal(await scalar(`SELECT status || ':' || version || ':' || product_id FROM source_product_map WHERE id='${mapping.mapId}'`),
      `verified:1:${mappingIds.product1}`);
    assert.equal(await scalar(`SELECT need_version || ':' || decision || ':' || unit_basis || ':' || unit
      || ':' || coalesce(supplied_unit,'-') || ':' || coalesce(authoritative_unit,'-')
      || ':' || observed_candidate_count || ':' || observed_candidates_truncated
      FROM need_mapping_decision WHERE id='${mapping.decisionId}'`),
      '1:explicit_human_selection:explicit_supplied_unit:box:box:-:3:false');
    assert.equal(await scalar(`SELECT decided_by='${ids.memberA}' FROM need_mapping_decision WHERE id='${mapping.decisionId}'`), 't');

    // The same command replayed at the version it already consumed is stale, not idempotent.
    const stale = await bind(mappingIds.needC, { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'box' });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'NEED_VERSION_CONFLICT');

    // The same mapping repeated at the current state is idempotent: no new row, no version change.
    const repeated = await bind(mappingIds.needC, { needVersion: 2, productId: mappingIds.product1, suppliedUnit: 'box' });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().repeated, true);
    assert.equal(repeated.json().mapId, mapping.mapId);
    assert.equal(repeated.json().decisionId, mapping.decisionId);
    assert.equal(repeated.json().needVersion, 2);
    assert.equal(await scalar(`SELECT version FROM need WHERE id='${mappingIds.needC}'`), '2');
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '1');

    // Choosing the other strength is a new decision: a new mapping row with a higher mapping version,
    // a second provenance row, and the earlier mapping left intact as history.
    const changed = await bind(mappingIds.needC, { needVersion: 2, productId: mappingIds.product2, suppliedUnit: 'box' });
    assert.equal(changed.statusCode, 201, changed.body);
    assert.notEqual(changed.json().mapId, mapping.mapId);
    assert.equal(changed.json().needVersion, 3);
    assert.equal(await scalar(`SELECT version FROM source_product_map WHERE id='${changed.json().mapId}'`), '2');
    assert.equal(await scalar(`SELECT status || ':' || product_id FROM source_product_map WHERE id='${mapping.mapId}'`),
      `verified:${mappingIds.product1}`);
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '2');

    // Two conflicting selections at the same observed version: exactly one is recorded.
    const [first, second] = await Promise.all([
      bind(mappingIds.needC, { needVersion: 3, productId: mappingIds.product1, suppliedUnit: 'box' }),
      bind(mappingIds.needC, { needVersion: 3, productId: mappingIds.strip, suppliedUnit: 'strip' }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409], `${first.body}\n${second.body}`);
    const refused = first.statusCode === 409 ? first : second;
    assert.equal(refused.json().error.code, 'NEED_VERSION_CONFLICT');
    assert.equal(await scalar(`SELECT version FROM need WHERE id='${mappingIds.needC}'`), '4');
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '3');
    assert.equal(await scalar(`SELECT count(DISTINCT need_version) FROM need_mapping_decision WHERE need_id='${mappingIds.needC}'`), '3');

    // Authoritative unit metadata carries the decision without any supplied unit, and refuses a
    // supplied unit that contradicts it or a pack sold in another unit.
    const authoritative = await bind(mappingIds.needD, { needVersion: 1, productId: mappingIds.product2 });
    assert.equal(authoritative.statusCode, 201, authoritative.body);
    assert.equal(authoritative.json().unitBasis, 'authoritative_metadata');
    assert.equal(authoritative.json().unit, 'box');
    assert.equal(await scalar(`SELECT coalesce(supplied_unit,'-') || ':' || authoritative_unit || ':' || observed_candidate_count
      FROM need_mapping_decision WHERE id='${authoritative.json().decisionId}'`), '-:box:2');
    const contradicted = await bind(mappingIds.needD, { needVersion: 2, productId: mappingIds.product2, suppliedUnit: 'strip' });
    assert.equal(contradicted.statusCode, 422, contradicted.body);
    assert.equal(contradicted.json().error.code, 'UNIT_MISMATCH');
    const acrossUnits = await bind(mappingIds.needE, { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'strip' });
    assert.equal(acrossUnits.statusCode, 422, acrossUnits.body);
    assert.equal(acrossUnits.json().error.code, 'UNIT_MISMATCH');

    // The shared catalogue was only read, and the request path holds no privilege to change it or to
    // rewrite a recorded decision.
    assert.equal(await catalogueDigest(), before);
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await privilege('procurement_product', action), 'f', `procurement_product ${action}`);
    }
    assert.equal(await privilege('procurement_product', 'SELECT'), 't');
    assert.equal(await privilege('need_mapping_decision', 'INSERT'), 't');
    assert.equal(await privilege('need_mapping_decision', 'SELECT'), 't');
    assert.equal(await privilege('need_mapping_decision', 'UPDATE'), 'f');
    assert.equal(await privilege('need_mapping_decision', 'DELETE'), 'f');
    assert.equal(await privilege('source_product_map', 'INSERT'), 't');
    assert.equal(await privilege('source_product_map', 'UPDATE'), 'f');
    assert.equal(await privilege('source_product_map', 'DELETE'), 'f');
    assert.equal(await scalar("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname='need_mapping_decision'"), 't');
  } finally {
    await app.close();
    await pool.end();
    await identity.close();
  }
});

test('AC-002/AC-008 evidence: a changed mapping invalidates a stale quote and a covered need refuses remapping', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = mappingApi(pool, createAccessTokenVerifier({
    issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api',
  }));
  try {
    await seedProcurement();
    await seedMappingFixture();
    const { access_token: token } = await identity.token(OWNER_SUBJECT);
    const headers = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const quotePayload = {
      branchId: ids.branchA,
      lines: [{ needId: ids.needA, needVersion: 1, quantity: '2', unit: 'box' }],
      constraints: { supplierIds: [], paymentTerm: 'cash' },
    };
    const bind = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/v1/needs/${ids.needA}/mapping`, headers, payload });

    const quoted = await app.inject({ method: 'POST', url: '/v1/quotes', headers, payload: quotePayload });
    assert.equal(quoted.statusCode, 201, quoted.body);
    const quoteId = quoted.json().id;
    const snapshot = await scalar(`SELECT terms_hash || ':' || (lines->0->>'productId') || ':' || (lines->0->>'mapVersion') || ':' || total
      FROM quote WHERE id='${quoteId}'`);

    // Re-mapping the need to the other strength increments the need version.
    const remapped = await bind({ needVersion: 1, productId: mappingIds.product2, suppliedUnit: 'box' });
    assert.equal(remapped.statusCode, 201, remapped.body);
    assert.equal(remapped.json().needVersion, 2);

    // The quote that captured the earlier mapping can no longer be approved, and its stored snapshot
    // is untouched: the refusal comes from the version it recorded, not from editing history.
    const approveStale = await app.inject({
      method: 'POST', url: `/v1/quotes/${quoteId}/approve`,
      headers: { ...headers, 'idempotency-key': 'mapping-stale' }, payload: { quoteVersion: 1 },
    });
    assert.equal(approveStale.statusCode, 409, approveStale.body);
    assert.equal(approveStale.json().error.code, 'REQUOTE_REQUIRED');
    assert.equal(await scalar(`SELECT terms_hash || ':' || (lines->0->>'productId') || ':' || (lines->0->>'mapVersion') || ':' || total
      FROM quote WHERE id='${quoteId}'`), snapshot);
    assert.equal(await scalar(`SELECT status FROM quote WHERE id='${quoteId}'`), 'quoted');
    assert.equal(await scalar('SELECT count(*) FROM approval'), '0');
    assert.equal(await scalar('SELECT count(*) FROM budget_reservation'), '0');
    assert.equal(await scalar('SELECT reserved_amount=0 FROM budget'), 't');

    // Re-selecting the pack that has a binding offer, then quoting and approving at the current
    // version, covers the need exactly.
    const restored = await bind({ needVersion: 2, productId: mappingIds.product1, suppliedUnit: 'box' });
    assert.equal(restored.statusCode, 201, restored.body);
    assert.equal(restored.json().needVersion, 3);
    const fresh = await app.inject({
      method: 'POST', url: '/v1/quotes', headers,
      payload: { ...quotePayload, lines: [{ ...quotePayload.lines[0], needVersion: 3 }] },
    });
    assert.equal(fresh.statusCode, 201, fresh.body);
    const approved = await app.inject({
      method: 'POST', url: `/v1/quotes/${fresh.json().id}/approve`,
      headers: { ...headers, 'idempotency-key': 'mapping-covered' }, payload: { quoteVersion: 1 },
    });
    assert.equal(approved.statusCode, 202, approved.body);
    assert.equal(await scalar(`SELECT status || ':' || version FROM need WHERE id='${ids.needA}'`), 'covered:4');

    // A covered need is settled: its mapping is no longer editable, at any version.
    const afterCoverage = await bind({ needVersion: 4, productId: mappingIds.product2, suppliedUnit: 'box' });
    assert.equal(afterCoverage.statusCode, 409, afterCoverage.body);
    assert.equal(afterCoverage.json().error.code, 'NEED_NOT_OPEN');
    const repeatAfterCoverage = await bind({ needVersion: 4, productId: mappingIds.product1, suppliedUnit: 'box' });
    assert.equal(repeatAfterCoverage.statusCode, 409, repeatAfterCoverage.body);
    assert.equal(repeatAfterCoverage.json().error.code, 'NEED_NOT_OPEN');
    assert.equal(await scalar(`SELECT status || ':' || version FROM need WHERE id='${ids.needA}'`), 'covered:4');
    assert.equal(await scalar(`SELECT count(*) FROM need_mapping_decision WHERE need_id='${ids.needA}'`), '2');
    assert.equal(await scalar('SELECT count(*) FROM approval'), '1');
  } finally {
    await app.close();
    await pool.end();
    await identity.close();
  }
});

test('AC-001 evidence: provenance cannot cite a foreign need or claim a product its mapping does not carry', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = mappingApi(pool, createAccessTokenVerifier({
    issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api',
  }));
  try {
    await seedProcurement();
    await seedMappingFixture();
    const { access_token: token } = await identity.token(OWNER_SUBJECT);
    const bound = await app.inject({
      method: 'POST', url: `/v1/needs/${mappingIds.needC}/mapping`,
      headers: { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA },
      payload: { needVersion: 1, productId: mappingIds.product1, suppliedUnit: 'box' },
    });
    assert.equal(bound.statusCode, 201, bound.body);
    const mapId = bound.json().mapId;
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '1');

    // Control: written directly through the runtime role, a well formed row is accepted. Every
    // refusal below therefore comes from the lineage it breaks, not from an unrelated constraint.
    const accepted = await insertDecisionAsTenantA(pool, mappingIds.needC, 99, mapId, mappingIds.product1);
    assert.equal(accepted.rowCount, 1);
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '2');

    // Tenant A declares its own organisation and branch, so the tenant_scope WITH CHECK is satisfied
    // and only the composite reference stands between it and tenant B's need. Referential checks
    // bypass row level security, so a plain reference to need(id) would have accepted this row.
    const foreign = await refusedDecision(pool, ids.needB, 1, mapId, mappingIds.product1);
    assert.equal(foreign.code, '23503', foreign.message);
    // The refusal repeats only the identifiers the caller supplied; none of tenant B's data appears.
    assert.doesNotMatch(foreign.message, /SYN-B-PRIVATE/);
    assert.doesNotMatch(foreign.message, new RegExp(`${ids.b}|${ids.branchB}|${ids.memberB}`));

    // A need that exists in the acting organisation but in another branch is refused by the same
    // reference, so the lineage is per branch and not merely per organisation.
    await sql(`INSERT INTO branch(id,organisation_id,name,timezone) VALUES
      ('20000000-0000-4000-8000-000000000009','${ids.a}','A2','Asia/Bahrain');
      INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity) VALUES
      ('40000000-0000-4000-8000-000000000009','${ids.a}','20000000-0000-4000-8000-000000000009','SYN-A2',1);`);
    const otherBranch = await refusedDecision(pool, '40000000-0000-4000-8000-000000000009', 1, mapId, mappingIds.product1);
    assert.equal(otherBranch.code, '23503', otherBranch.message);

    // The mapping row carries the first pack, so provenance may not claim the second, the pack under
    // review, or one that is absent from the catalogue entirely.
    for (const claimed of [mappingIds.product2, mappingIds.strip, mappingIds.unverified, ABSENT_ID]) {
      const mismatch = await refusedDecision(pool, mappingIds.needC, 98, mapId, claimed);
      assert.equal(mismatch.code, '23503', `${claimed}: ${mismatch.message}`);
    }
    // A mapping identity that belongs to no tenant row at all is refused the same way.
    const absentMap = await refusedDecision(pool, mappingIds.needC, 97, ABSENT_ID, mappingIds.product1);
    assert.equal(absentMap.code, '23503', absentMap.message);

    // Nothing landed: the control row is the only addition, and tenant B gained no provenance.
    assert.equal(await scalar('SELECT count(*) FROM need_mapping_decision'), '2');
    assert.equal(await scalar(`SELECT count(*) FROM need_mapping_decision WHERE need_id='${ids.needB}'`), '0');
    assert.equal(await scalar(`SELECT count(*) FROM need_mapping_decision WHERE product_id<>'${mappingIds.product1}'`), '0');
    assert.equal(await scalar(`SELECT count(*) FROM need_mapping_decision d
      JOIN source_product_map m ON m.id=d.map_id WHERE m.product_id IS DISTINCT FROM d.product_id`), '0');
    assert.equal(await scalar(`SELECT count(*) FROM need_mapping_decision d
      JOIN need n ON n.id=d.need_id
      WHERE n.organisation_id IS DISTINCT FROM d.organisation_id OR n.branch_id IS DISTINCT FROM d.branch_id`), '0');
  } finally {
    await app.close();
    await pool.end();
    await identity.close();
  }
});
