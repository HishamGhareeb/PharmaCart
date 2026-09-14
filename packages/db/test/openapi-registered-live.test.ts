import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { LightMyRequestResponse } from 'fastify';

import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { isUtcInstant } from '../../contracts/src/submission.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { ids, resetDatabase, sql } from './support.ts';

/*
 * LIVE EVIDENCE for the list and mapping routes as buildTenantApi registers them. Every payload below
 * was produced over a real pharmacart_test database and a real authorization-code token from the local
 * OIDC provider, and is validated against the schema the generated document publishes for exactly that
 * operation and status. Nothing registers a route here: the production route tree is used unchanged.
 *
 * It validates documentation conformance, tenant isolation of every body including refusals, and the
 * role policy the routes enforce. It advances no acceptance criterion. The coordinator runs it serially
 * with the other database suites (npm run test:integration).
 */

type Schema = Record<string, unknown>;
type Operation = { operationId: string; responses: Record<string, { content: { 'application/json': { schema: { $ref: string } } } }> };
type Document = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };
type Served = LightMyRequestResponse;

const document = JSON.parse(readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8')) as Document;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uuid: (value: string) => UUID.test(value), 'date-time': isUtcInstant },
});

/** Synthetic rows added for this file only. The shared fixture ids are untouched. */
const extra = {
  receiver: '30000000-0000-4000-8000-000000000004',
  needC: '4000000c-0000-4000-8000-00000000000c',
  product1: '60000000-0000-4000-8000-000000000001',
  product2: '60000000-0000-4000-8000-000000000002',
  absent: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

/** Validates a live response against the schema the document names for this operation and status. */
function served(path: string, method: 'get' | 'post', response: Served, because: string): void {
  const operation = document.paths[path]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} is missing from the generated document`);
  const documented = operation.responses[String(response.statusCode)];
  assert.ok(documented, `${operation.operationId} returned undocumented status ${response.statusCode}: ${response.body}`);
  const name = documented.content['application/json'].schema.$ref.replace('#/components/schemas/', '');
  const validator = ajv.compile(document.components.schemas[name]!);
  assert.equal(validator(response.json()), true, `live ${because} violates ${name}: ${ajv.errorsText(validator.errors)}\n${response.body}`);
  if (response.statusCode >= 300) assert.equal(response.json().error.correlationId, response.headers['x-correlation-id'], `${because} correlation echo`);
}

const NOT_PERMITTED = 'The selected scope is not permitted.';
const privateToB = new RegExp(`SYN-B-PRIVATE|${ids.b}|${ids.branchB}|${ids.memberB}`);
const privateToA = new RegExp(`SYN-A|SYN-C|${ids.a}|${ids.branchA}|${ids.memberA}|${extra.receiver}`);

test('live contracts: registered list and mapping routes over real OIDC and PostgreSQL', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = buildTenantApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement();
    // synthetic:user:b is a purchaser in B (support.ts) and, here, a receiver in A. The need in A has no
    // mapping and no connector unit, so binding it needs an explicit supplied unit.
    await sql(`INSERT INTO membership(id,organisation_id,user_subject,role,status) VALUES
      ('${extra.receiver}','${ids.a}','synthetic:user:b','receiver','active');
      INSERT INTO membership_branch VALUES ('${ids.a}','${extra.receiver}','${ids.branchA}');
      INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity,source_ref) VALUES
      ('${extra.needC}','${ids.a}','${ids.branchA}','SYN-C',5,NULL);`);
    const { access_token: ownerToken } = await identity.token('synthetic:user:a');
    const { access_token: userBToken } = await identity.token('synthetic:user:b');
    const owner = { authorization: `Bearer ${ownerToken}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const purchaserB = { authorization: `Bearer ${userBToken}`, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB };
    const receiverA = { authorization: `Bearer ${userBToken}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const get = (url: string, headers?: Record<string, string>) => app.inject({ method: 'GET', url, ...(headers === undefined ? {} : { headers }) });
    const post = (url: string, headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url, headers, payload });

    const document_ = await get('/openapi.json');
    assert.equal(document_.statusCode, 200);
    assert.deepEqual(document_.json(), document, 'the schemas validated here are the ones this server publishes');

    // 1. Need pages: a keyset walk of the owner's branch, each page conforming to NeedPage.
    const first = await get('/v1/needs?limit=1', owner);
    assert.equal(first.statusCode, 200, first.body);
    served('/v1/needs', 'get', first, 'first need page');
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.deepEqual(first.json().items, [{
      id: ids.needA, productRef: 'SYN-A', quantity: '2', outstandingQuantity: '2', status: 'open', version: 1,
      mappingStatus: 'verified', productId: extra.product1, saleUnit: 'box',
    }]);
    assert.match(first.json().nextCursor, /^[A-Za-z0-9_-]+$/);
    const second = await get(`/v1/needs?limit=1&cursor=${first.json().nextCursor}`, owner);
    assert.equal(second.statusCode, 200, second.body);
    served('/v1/needs', 'get', second, 'last need page');
    assert.deepEqual(second.json(), { items: [{
      id: extra.needC, productRef: 'SYN-C', quantity: '5', outstandingQuantity: '5', status: 'open', version: 1,
      mappingStatus: 'unmapped', productId: null, saleUnit: null,
    }], nextCursor: null });
    assert.doesNotMatch(first.body + second.body, privateToB);

    // 2. The purchaser in B lists only B, and a cursor issued to A is refused in B like a malformed one.
    const needsB = await get('/v1/needs?limit=100', purchaserB);
    assert.equal(needsB.statusCode, 200, needsB.body);
    served('/v1/needs', 'get', needsB, 'purchaser need page');
    assert.deepEqual(needsB.json().items.map((item: { id: string }) => item.id), [ids.needB]);
    assert.doesNotMatch(needsB.body, privateToA);
    const crossTenant = await get(`/v1/needs?limit=1&cursor=${first.json().nextCursor}`, purchaserB);
    const malformed = await get('/v1/needs?limit=1&cursor=Zm9yZ2VkLWN1cnNvcg', purchaserB);
    for (const [response, because] of [[crossTenant, 'foreign cursor refusal'], [malformed, 'malformed cursor refusal']] as const) {
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, 'INVALID_CURSOR');
      served('/v1/needs', 'get', response, because);
      assert.doesNotMatch(response.body, privateToA);
    }
    assert.equal(crossTenant.json().error.message, malformed.json().error.message);

    // 3. Order pages: empty, then one queued intent after a real quote and approval.
    const noOrders = await get('/v1/orders', owner);
    assert.equal(noOrders.statusCode, 200, noOrders.body);
    served('/v1/orders', 'get', noOrders, 'empty order page');
    assert.deepEqual(noOrders.json(), { items: [], nextCursor: null });
    const quote = await post('/v1/quotes', owner, { branchId: ids.branchA, lines: [{ needId: ids.needA, needVersion: 1, quantity: '2', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } });
    assert.equal(quote.statusCode, 201, quote.body);
    const approval = await post(`/v1/quotes/${quote.json().id}/approve`, { ...owner, 'idempotency-key': 'registered-live' }, { quoteVersion: 1 });
    assert.equal(approval.statusCode, 202, approval.body);
    const intentId = approval.json().orderIntentIds[0] as string;
    const orders = await get('/v1/orders?status=queued', owner);
    assert.equal(orders.statusCode, 200, orders.body);
    served('/v1/orders', 'get', orders, 'queued order page');
    assert.deepEqual(orders.json(), { items: [{
      id: intentId, state: 'queued', version: 1, externalClientRef: `pc-syn-${intentId}`, externalOrderId: null,
      lines: { total: 0, settled: 0, awaitingReceipt: 0 }, uncertainty: null,
    }], nextCursor: null });
    assert.doesNotMatch(orders.body, new RegExp(`${ids.supplier}|${quote.json().id}|EGP|12\\.35|24\\.7`));
    const ordersB = await get('/v1/orders', purchaserB);
    assert.equal(ordersB.statusCode, 200, ordersB.body);
    served('/v1/orders', 'get', ordersB, 'purchaser order page');
    assert.deepEqual(ordersB.json(), { items: [], nextCursor: null });

    // 4. Role policy: a receiver in A is refused every list and mapping operation, worded as a denied membership.
    for (const [path, method, response] of [
      ['/v1/needs', 'get', await get('/v1/needs', receiverA)],
      ['/v1/orders', 'get', await get(`/v1/orders?cursor=${first.json().nextCursor}`, receiverA)],
      ['/v1/needs/{id}/mapping-candidates', 'get', await get(`/v1/needs/${extra.needC}/mapping-candidates`, receiverA)],
      ['/v1/needs/{id}/mapping', 'post', await post(`/v1/needs/${extra.needC}/mapping`, receiverA, { needVersion: 1, productId: extra.product1, suppliedUnit: 'box' })],
    ] as const) {
      assert.equal(response.statusCode, 403, `${path}: ${response.body}`);
      assert.deepEqual([response.json().error.code, response.json().error.message], ['FORBIDDEN', NOT_PERMITTED], path);
      served(path, method, response, `receiver refusal on ${path}`);
      assert.doesNotMatch(response.body, /SYN-|receiver|INVALID_CURSOR/);
    }

    // 5. Boundary refusals on the lists.
    const badLimit = await get('/v1/needs?limit=0', owner);
    assert.equal(badLimit.statusCode, 400, badLimit.body);
    served('/v1/needs', 'get', badLimit, 'malformed limit refusal');
    const anonymous = await get('/v1/orders');
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    served('/v1/orders', 'get', anonymous, 'anonymous list refusal');
    const wrongScope = await get('/v1/needs', { ...owner, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB });
    assert.equal(wrongScope.statusCode, 403, wrongScope.body);
    served('/v1/needs', 'get', wrongScope, 'foreign scope list refusal');
    assert.doesNotMatch(wrongScope.body, privateToB);

    // 6. Mapping candidates for owner and purchaser, and a foreign need indistinguishable from an absent one.
    const candidates = await get(`/v1/needs/${extra.needC}/mapping-candidates`, owner);
    assert.equal(candidates.statusCode, 200, candidates.body);
    served('/v1/needs/{id}/mapping-candidates', 'get', candidates, 'owner candidate list');
    assert.equal(candidates.json().needVersion, 1);
    assert.equal(candidates.json().currentProductId, null);
    assert.equal(candidates.json().unitBasis, 'explicit_supplied_unit_required');
    assert.equal(candidates.json().ambiguous, true);
    assert.equal(candidates.json().unselectableExcluded, 0);
    assert.deepEqual(candidates.json().candidates.map((candidate: { productId: string }) => candidate.productId), [extra.product1, extra.product2]);
    assert.doesNotMatch(candidates.body, /price|currency|EGP|offer|supplier/i);
    const purchaserCandidates = await get(`/v1/needs/${ids.needB}/mapping-candidates`, purchaserB);
    assert.equal(purchaserCandidates.statusCode, 200, purchaserCandidates.body);
    served('/v1/needs/{id}/mapping-candidates', 'get', purchaserCandidates, 'purchaser candidate list');
    assert.doesNotMatch(purchaserCandidates.body, privateToA);
    const foreignNeed = await get(`/v1/needs/${ids.needB}/mapping-candidates`, owner);
    const absentNeed = await get(`/v1/needs/${extra.absent}/mapping-candidates`, owner);
    for (const [response, because] of [[foreignNeed, 'foreign need refusal'], [absentNeed, 'absent need refusal']] as const) {
      assert.equal(response.statusCode, 404, response.body);
      served('/v1/needs/{id}/mapping-candidates', 'get', response, because);
      assert.doesNotMatch(response.body, privateToB);
    }
    assert.equal(foreignNeed.json().error.message, absentNeed.json().error.message);

    // 7. Binding: every refusal, then a new decision, then the idempotent repeat.
    const bind = (needId: string, payload: object, headers: Record<string, string> = owner) => post(`/v1/needs/${needId}/mapping`, headers, payload);
    const refusals: readonly [string, object, Record<string, string>, number, string][] = [
      [extra.needC, { needVersion: 1, productId: extra.product1 }, owner, 422, 'SUPPLIED_UNIT_REQUIRED'],
      [extra.needC, { needVersion: 1, productId: extra.product1, suppliedUnit: 'strip' }, owner, 422, 'UNIT_MISMATCH'],
      [extra.needC, { needVersion: 1, productId: extra.absent, suppliedUnit: 'box' }, owner, 422, 'CATALOGUE_UNVERIFIED'],
      [extra.needC, { needVersion: 2, productId: extra.product1, suppliedUnit: 'box' }, owner, 409, 'NEED_VERSION_CONFLICT'],
      // The approval above covered need A at version 2, so its mapping is settled history.
      [ids.needA, { needVersion: 2, productId: extra.product2, suppliedUnit: 'box' }, owner, 409, 'NEED_NOT_OPEN'],
      [ids.needB, { needVersion: 1, productId: extra.product1, suppliedUnit: 'box' }, owner, 404, 'NOT_FOUND'],
      [ids.needB, { needVersion: 1, productId: extra.product1, suppliedUnit: 'box' }, purchaserB, 403, 'FORBIDDEN'],
      [extra.needC, { needVersion: 1, productId: extra.product1, autoSelect: true }, owner, 400, 'INVALID_REQUEST'],
    ];
    for (const [needId, payload, headers, status, code] of refusals) {
      const response = await bind(needId, payload, headers);
      assert.equal(response.statusCode, status, `${code}: ${response.body}`);
      assert.equal(response.json().error.code, code, response.body);
      served('/v1/needs/{id}/mapping', 'post', response, `${code} refusal`);
      assert.doesNotMatch(response.body, headers === purchaserB ? privateToA : privateToB, code);
      assert.doesNotMatch(response.body, /autoSelect|SYN Brand|SYN Maker/);
    }
    assert.equal((await sql('SELECT count(*) FROM need_mapping_decision')).trim(), '0', 'no refusal may have recorded a decision');

    const created = await bind(extra.needC, { needVersion: 1, productId: extra.product1, suppliedUnit: 'box' });
    assert.equal(created.statusCode, 201, created.body);
    served('/v1/needs/{id}/mapping', 'post', created, 'new mapping decision');
    assert.equal(created.json().needVersion, 2);
    assert.equal(created.json().repeated, false);
    assert.equal(created.json().unitBasis, 'explicit_supplied_unit');
    const repeated = await bind(extra.needC, { needVersion: 2, productId: extra.product1, suppliedUnit: 'box' });
    assert.equal(repeated.statusCode, 200, repeated.body);
    served('/v1/needs/{id}/mapping', 'post', repeated, 'idempotent repeat');
    assert.deepEqual(repeated.json(), { ...created.json(), repeated: true });
    assert.equal((await sql('SELECT count(*) FROM need_mapping_decision')).trim(), '1');

    // 8. The decision is visible through both reads, still conforming.
    const remapped = await get(`/v1/needs?status=open&limit=100`, owner);
    assert.equal(remapped.statusCode, 200, remapped.body);
    served('/v1/needs', 'get', remapped, 'need page after binding');
    assert.deepEqual(remapped.json().items.map((item: { id: string; mappingStatus: string; productId: string | null; saleUnit: string | null; version: number }) =>
      [item.id, item.mappingStatus, item.productId, item.saleUnit, item.version]), [[extra.needC, 'verified', extra.product1, 'box', 2]]);
    const afterBind = await get(`/v1/needs/${extra.needC}/mapping-candidates`, owner);
    assert.equal(afterBind.statusCode, 200, afterBind.body);
    served('/v1/needs/{id}/mapping-candidates', 'get', afterBind, 'candidate list after binding');
    assert.equal(afterBind.json().currentProductId, extra.product1);
    assert.equal(afterBind.json().needVersion, 2);
  } finally {
    await app.close(); await pool.end(); await identity.close();
  }
});
