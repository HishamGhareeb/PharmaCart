import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

import { renderOpenapi } from '../../../packages/contracts/scripts/openapi.ts';
import { isUtcInstant } from '../../../packages/contracts/src/submission.ts';
import {
  MAX_CURSOR_LENGTH,
  MAX_LIMIT,
  MAX_SALE_UNIT_LENGTH,
  encodeCursor,
  parseListQuery,
  type NeedRow,
  type OrderRow,
} from '../../../packages/db/src/lists.ts';
import { MAX_MAPPING_CANDIDATES } from '../../../packages/db/src/mapping.ts';
import { MembershipAccessDeniedError, type RuntimeClient, type TenantContext } from '../../../packages/db/src/runtime.ts';
import { buildApp } from '../src/app.ts';
import { registerListRoutes, type ListScope } from '../src/list-routes.ts';
import type { TenantScope, TokenVerifier } from '../src/request-auth.ts';
import { buildTenantApi } from '../src/tenant-api.ts';
import {
  MAPPING_BIND_URL,
  MAPPING_CANDIDATES_URL,
  MAPPING_HEADERS,
  MAPPING_IDS,
  MAPPING_REFUSALS,
  OPEN_NEED,
  REJECTING_VERIFIER,
  SELECTION,
  UNUSABLE_POOL,
  VERIFIED_CATALOGUE,
  mappingContext,
  scriptedScope,
  withMappingRoutes,
} from './mapping-fixture.ts';

/*
 * Real response evidence. Every payload asserted here was produced by a running Fastify instance through
 * inject, not hand written. buildApp only serves the two unauthenticated operations, so the tenant
 * contracts (context, needs, inventory, quotes, approve, order detail, receipt) cannot be exercised here.
 *
 * The list and mapping routes are the exception: they accept an injected tenant scope, so their real
 * route, repository mapping and error handler produce every status below without PostgreSQL. The rows
 * and statement answers behind them are synthetic, so these cases prove the served shapes and envelopes
 * match the document, not that the SQL is valid. The live PostgreSQL half is
 * packages/db/test/openapi-registered-live.test.ts.
 *
 * AWAITING COORDINATOR: those seven contracts are validated against synthetic examples in
 * packages/contracts/test/openapi-responses.test.ts and must still be checked against real PostgreSQL
 * integration responses before any acceptance gate moves. See docs/testing/openapi-responses.md.
 */

type Schema = Record<string, unknown>;
type Operation = { operationId: string; security?: unknown[]; responses: Record<string, { content: { 'application/json': { schema: { $ref?: string } } } }> };
type Document = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };

const generatedPath = new URL('../../../packages/contracts/openapi.json', import.meta.url);
const generated = readFileSync(generatedPath, 'utf8');
const document = JSON.parse(generated) as Document;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uuid: (value: string) => UUID.test(value), 'date-time': isUtcInstant },
});

const PREFIX = '#/components/schemas/';

function componentFor(reference: string | undefined): Schema {
  assert.ok(typeof reference === 'string' && reference.startsWith(PREFIX), `expected a named component contract, received ${String(reference)}`);
  const name = reference.slice(PREFIX.length);
  const schema = document.components.schemas[name];
  assert.ok(schema, `components.schemas.${name} is missing from the generated document`);
  return schema;
}

function conforms(reference: string | undefined, payload: unknown, because: string): void {
  const validator = ajv.compile(componentFor(reference));
  assert.equal(validator(payload), true, `${because} does not satisfy ${String(reference)}: ${ajv.errorsText(validator.errors)}`);
}

const successReference = (operation: Operation): string | undefined =>
  Object.entries(operation.responses).find(([code]) => Number(code) < 300)?.[1].content['application/json'].schema.$ref;

const errorReference = (operation: Operation): string | undefined =>
  operation.responses['404']?.content['application/json'].schema.$ref;

async function withApp(run: (app: FastifyInstance) => Promise<void>, register?: (app: FastifyInstance) => void, bodyLimit?: number): Promise<void> {
  const app = buildApp({ ...(register === undefined ? {} : { register }), ...(bodyLimit === undefined ? {} : { bodyLimit }) });
  try { await run(app); } finally { await app.close(); }
}

describe('served responses satisfy the generated contracts', () => {
  test('the served document is the generated artifact and satisfies its own contract', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      assert.equal(response.statusCode, 200);
      assert.equal(generated, renderOpenapi(), 'openapi.json is stale; run npm run contracts:generate');
      assert.deepEqual(response.json(), document);
      conforms(successReference(document.paths['/openapi.json']!.get!), response.json(), 'the served OpenAPI document');
    });
  });

  test('the health response satisfies the documented health contract', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: 'ok' });
      conforms(successReference(document.paths['/health']!.get!), response.json(), 'the health response');
    });
  });

  test('buildApp serves exactly the unauthenticated operations and refuses the tenant paths', async () => {
    await withApp(async (app) => {
      for (const [path, methods] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          const url = path.replace('{id}', 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d03');
          const request = method === 'post'
            ? { method: 'POST' as const, url, headers: { 'content-type': 'application/json' }, payload: {} }
            : { method: 'GET' as const, url };
          const response = await app.inject(request);
          const unauthenticated = Array.isArray(operation.security) && operation.security.length === 0;
          if (unauthenticated) {
            assert.equal(response.statusCode, 200, `${operation.operationId}: ${response.body}`);
            conforms(successReference(operation), response.json(), `the ${operation.operationId} response`);
            continue;
          }
          // Registered only by buildTenantApi, which requires a database pool and a token verifier.
          assert.equal(response.statusCode, 404, `${operation.operationId} must not be reachable without a tenant runtime`);
          assert.equal(response.json().error.code, 'NOT_FOUND');
          conforms(errorReference(operation), response.json(), `the ${operation.operationId} absence response`);
        }
      }
    });
  });

  test('boundary failures keep satisfying the documented error envelope', async () => {
    const envelope = errorReference(document.paths['/health']!.get!);
    await withApp(async (app) => {
      const missing = await app.inject({ method: 'GET', url: '/missing' });
      assert.equal(missing.statusCode, 404);
      conforms(envelope, missing.json(), 'the unknown route response');

      const malformed = await app.inject({ method: 'POST', url: '/boundary', headers: { 'content-type': 'application/json' }, payload: '{"broken"' });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, 'INVALID_JSON');
      conforms(envelope, malformed.json(), 'the malformed body response');

      const failure = await app.inject({ method: 'GET', url: '/failure' });
      assert.equal(failure.statusCode, 500);
      assert.equal(failure.json().error.code, 'INTERNAL_ERROR');
      conforms(envelope, failure.json(), 'the redacted internal error response');

      // 415 is emitted by the shared error handler but is not enumerated in the document; the envelope
      // still has to match, and the missing status is recorded in docs/testing/openapi-responses.md.
      const media = await app.inject({ method: 'POST', url: '/boundary', headers: { 'content-type': 'application/xml' }, payload: '<x/>' });
      assert.equal(media.statusCode, 415);
      conforms(envelope, media.json(), 'the unsupported media type response');
    }, (app) => {
      app.post('/boundary', async () => ({ accepted: true }));
      app.get('/failure', async () => { throw new Error('synthetic-failure'); });
    });

    await withApp(async (app) => {
      const oversized = await app.inject({ method: 'POST', url: '/boundary', headers: { 'content-type': 'application/json' }, payload: { value: 'larger than the limit' } });
      assert.equal(oversized.statusCode, 413);
      assert.equal(oversized.json().error.code, 'PAYLOAD_TOO_LARGE');
      conforms(envelope, oversized.json(), 'the oversized body response');
    }, (app) => { app.post('/boundary', async () => ({ accepted: true })); }, 8);
  });
});

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

/** The schema reference the document publishes for exactly this operation and status. */
function documentedReference(path: string, method: 'get' | 'post', status: number): string | undefined {
  const operation = document.paths[path]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} is missing from the generated document`);
  const response = operation.responses[String(status)];
  assert.ok(response, `${operation.operationId} returned ${status}, which the generated document does not list`);
  return response.content['application/json'].schema.$ref;
}

/** Validates a served response against the document: status listed, body schema, correlation echo. */
function servedConforms(path: string, method: 'get' | 'post', response: Injected, because: string): void {
  conforms(documentedReference(path, method, response.statusCode), response.json(), because);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', because);
  assert.match(String(response.headers['x-correlation-id']), UUID, `${because} correlation header`);
  if (response.statusCode >= 300) assert.equal(response.json().error.correlationId, response.headers['x-correlation-id'], `${because} correlation echo`);
}

const LIST_TENANT: TenantContext = mappingContext();
const FOREIGN_SCOPE = { organisationId: MAPPING_IDS.foreignOrganisation, branchId: MAPPING_IDS.foreignBranch };

const NEED_ROWS: readonly NeedRow[] = [
  { id: '40000000-0000-4000-8000-000000000001', productRef: 'SYN-A', quantity: '2.500', status: 'open', version: 3,
    sourceMapId: MAPPING_IDS.map, mapStatus: 'verified', productStatus: 'verified', productId: MAPPING_IDS.product, saleUnit: 'box' },
  { id: '40000000-0000-4000-8000-000000000003', productRef: 'SYN-A-QUOTED', quantity: '7', status: 'quoted', version: 1,
    sourceMapId: null, mapStatus: null, productStatus: null, productId: null, saleUnit: null },
  { id: '40000000-0000-4000-8000-000000000004', productRef: 'SYN-A-REVIEW', quantity: '4.0', status: 'closed', version: 2,
    sourceMapId: MAPPING_IDS.map, mapStatus: 'review', productStatus: 'verified', productId: MAPPING_IDS.product, saleUnit: 'box' },
];

const ORDER_ROWS: readonly OrderRow[] = [
  { id: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d03', state: 'queued', version: 1, externalClientRef: 'pc-syn-aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d03',
    externalOrderId: null, lineCount: 0, settledLines: 0, awaitingReceiptLines: 0 },
  { id: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d04', state: 'outcome_unknown', version: 3, externalClientRef: 'pc-syn-aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d04',
    externalOrderId: null, lineCount: 2, settledLines: 0, awaitingReceiptLines: 0 },
  { id: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d05', state: 'acknowledged', version: 4, externalClientRef: 'pc-syn-aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d05',
    externalOrderId: 'syn-1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6071', lineCount: 3, settledLines: 1, awaitingReceiptLines: 2 },
];

/** Answers the statements packages/db/src/lists.ts issues with synthetic rows; no SQL runs. */
function listClient(failure?: Error): RuntimeClient {
  return {
    query: (text: string) => {
      if (failure !== undefined) return Promise.reject(failure);
      if (text.startsWith('SELECT set_config')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (/FROM need AS n/.test(text)) return Promise.resolve({ rows: [...NEED_ROWS], rowCount: NEED_ROWS.length });
      if (/FROM order_intent AS i/.test(text)) return Promise.resolve({ rows: [...ORDER_ROWS], rowCount: ORDER_ROWS.length });
      return Promise.reject(new Error('unscripted list statement'));
    },
  } as unknown as RuntimeClient;
}

const listScope = (tenant: TenantContext, client: RuntimeClient = listClient()): ListScope => (_request, operation) => operation(client, tenant);

async function withListRoutes(scope: ListScope | undefined, run: (app: FastifyInstance) => Promise<void>, verifier: TokenVerifier = REJECTING_VERIFIER): Promise<void> {
  // No repository is injected: the real listNeeds/listOrders map the synthetic rows.
  await withApp(run, (app) => { registerListRoutes(app, UNUSABLE_POOL, verifier, scope === undefined ? {} : { scope }); });
}

const ACCEPTING_VERIFIER: TokenVerifier = {
  verifyAccessToken: () => Promise.resolve({ subject: 'synthetic:user:a' } as Awaited<ReturnType<TokenVerifier['verifyAccessToken']>>),
};

describe('registered list and mapping routes serve the generated contracts', () => {
  test('buildTenantApi answers every documented tenant read and the mapping write with the documented 401', async () => {
    // An unusable pool turns any connection attempt into a 500, which the 401 assertion would catch.
    const app = buildTenantApi(UNUSABLE_POOL, REJECTING_VERIFIER);
    try {
      for (const [path, methods] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          if (Array.isArray(operation.security) && operation.security.length === 0) continue;
          const url = path.replace('{id}', MAPPING_IDS.need);
          // Only the mapping write is exercised among the POST operations: the others need a full command
          // body to pass schema validation and are covered by packages/db/test/openapi-live.test.ts.
          if (method === 'post' && path !== '/v1/needs/{id}/mapping') continue;
          const response = await app.inject(method === 'post'
            ? { method: 'POST', url, headers: { 'x-organisation-id': MAPPING_IDS.organisation, 'x-branch-id': MAPPING_IDS.branch }, payload: SELECTION }
            : { method: 'GET', url, headers: { 'x-organisation-id': MAPPING_IDS.organisation, 'x-branch-id': MAPPING_IDS.branch } });
          assert.equal(response.statusCode, 401, `${operation.operationId}: ${response.body}`);
          assert.equal(response.json().error.code, 'UNAUTHENTICATED');
          servedConforms(path, method as 'get' | 'post', response, `the anonymous ${operation.operationId} response`);
        }
      }
    } finally { await app.close(); }
  });

  test('list pages served by the real repository mapping satisfy NeedPage and OrderPage', async () => {
    await withListRoutes(listScope(LIST_TENANT), async (app) => {
      const firstPage = await app.inject({ url: '/v1/needs?limit=2', headers: MAPPING_HEADERS });
      assert.equal(firstPage.statusCode, 200, firstPage.body);
      servedConforms('/v1/needs', 'get', firstPage, 'a need page with a continuation');
      assert.equal(firstPage.json().items.length, 2);
      assert.match(firstPage.json().nextCursor, /^[A-Za-z0-9_-]+$/);
      assert.equal(firstPage.headers['cache-control'], 'no-store');

      const lastPage = await app.inject({ url: '/v1/needs?limit=100', headers: MAPPING_HEADERS });
      assert.equal(lastPage.statusCode, 200, lastPage.body);
      servedConforms('/v1/needs', 'get', lastPage, 'the last need page');
      const [verified, quoted, review] = lastPage.json().items;
      assert.deepEqual([verified.productId, verified.saleUnit, verified.outstandingQuantity], [MAPPING_IDS.product, 'box', '2.500']);
      assert.deepEqual([quoted.mappingStatus, quoted.outstandingQuantity], ['unmapped', null]);
      assert.deepEqual([review.mappingStatus, review.productId, review.saleUnit, review.quantity, review.outstandingQuantity], ['unverified', null, null, '4.0', '0']);
      assert.equal(lastPage.json().nextCursor, null);

      const orders = await app.inject({ url: '/v1/orders?limit=100', headers: MAPPING_HEADERS });
      assert.equal(orders.statusCode, 200, orders.body);
      servedConforms('/v1/orders', 'get', orders, 'an order page');
      assert.deepEqual(orders.json().items.map((item: { uncertainty: unknown }) => item.uncertainty),
        [null, { safeToRetry: false, nextAction: 'reconciliation_required' }, null]);

      const orderContinuation = await app.inject({ url: '/v1/orders?limit=1&status=queued', headers: MAPPING_HEADERS });
      assert.equal(orderContinuation.statusCode, 200, orderContinuation.body);
      servedConforms('/v1/orders', 'get', orderContinuation, 'an order page with a continuation');
    });
  });

  test('every list refusal is a documented status carrying the documented envelope', async () => {
    const foreignCursor = encodeCursor('needs', FOREIGN_SCOPE, null, NEED_ROWS[0]!.id);
    const cases: readonly [string, ListScope | undefined, TokenVerifier, string, Record<string, string>, number, string][] = [
      ['a malformed limit', listScope(LIST_TENANT), REJECTING_VERIFIER, '/v1/needs?limit=0', MAPPING_HEADERS, 400, 'INVALID_REQUEST'],
      ['an unknown query key', listScope(LIST_TENANT), REJECTING_VERIFIER, `/v1/orders?organisationId=${FOREIGN_SCOPE.organisationId}`, MAPPING_HEADERS, 400, 'INVALID_REQUEST'],
      ['a status from the other vocabulary', listScope(LIST_TENANT), REJECTING_VERIFIER, '/v1/orders?status=open', MAPPING_HEADERS, 400, 'INVALID_REQUEST'],
      ['a foreign scope cursor', listScope(LIST_TENANT), REJECTING_VERIFIER, `/v1/needs?cursor=${foreignCursor}`, MAPPING_HEADERS, 400, 'INVALID_CURSOR'],
      ['a missing tenant selector', undefined, ACCEPTING_VERIFIER, '/v1/needs', { authorization: 'Bearer synthetic' }, 400, 'INVALID_REQUEST'],
      ['an anonymous caller', undefined, REJECTING_VERIFIER, '/v1/orders', MAPPING_HEADERS, 401, 'UNAUTHENTICATED'],
      ['a supplier organisation', listScope({ ...LIST_TENANT, organisationKind: 'supplier', role: 'supplier_operator' }), REJECTING_VERIFIER, '/v1/needs', MAPPING_HEADERS, 403, 'FORBIDDEN'],
      ['a receiver', listScope({ ...LIST_TENANT, role: 'receiver' }), REJECTING_VERIFIER, '/v1/orders', MAPPING_HEADERS, 403, 'FORBIDDEN'],
      ['a denied membership', () => Promise.reject(new MembershipAccessDeniedError()), REJECTING_VERIFIER, '/v1/needs', MAPPING_HEADERS, 403, 'FORBIDDEN'],
      ['a repository failure', listScope(LIST_TENANT, listClient(new Error('password authentication failed for pharmacart_test'))), REJECTING_VERIFIER, '/v1/orders', MAPPING_HEADERS, 500, 'INTERNAL_ERROR'],
    ];
    for (const [because, scope, verifier, url, headers, status, code] of cases) {
      await withListRoutes(scope, async (app) => {
        const response = await app.inject({ url, headers });
        assert.equal(response.statusCode, status, `${because}: ${response.body}`);
        assert.equal(response.json().error.code, code, because);
        servedConforms(url.split('?')[0]!, 'get', response, because);
        // No other tenant's selector and no internal detail ever reaches a refusal.
        assert.doesNotMatch(response.body, new RegExp(`${FOREIGN_SCOPE.organisationId}|${FOREIGN_SCOPE.branchId}|password|pharmacart_test|SYN-A`), because);
      }, verifier);
    }
  });

  test('mapping candidates and both binding outcomes satisfy MappingCandidates and MappingResult', async () => {
    const read = scriptedScope({ need: OPEN_NEED, catalogue: VERIFIED_CATALOGUE }, mappingContext('purchaser'));
    await withMappingRoutes(read.scope, async (app) => {
      const response = await app.inject({ url: MAPPING_CANDIDATES_URL, headers: MAPPING_HEADERS });
      assert.equal(response.statusCode, 200, response.body);
      servedConforms('/v1/needs/{id}/mapping-candidates', 'get', response, 'a candidate list');
    });

    const bounded = scriptedScope({
      need: { ...OPEN_NEED, sourceMapId: MAPPING_IDS.map },
      currentProductId: MAPPING_IDS.product,
      catalogue: Array.from({ length: MAX_MAPPING_CANDIDATES + 1 }, (_unused, index) =>
        ({ ...VERIFIED_CATALOGUE[0]!, id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })),
    });
    await withMappingRoutes(bounded.scope, async (app) => {
      const response = await app.inject({ url: MAPPING_CANDIDATES_URL, headers: MAPPING_HEADERS });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().truncated, true);
      assert.equal(response.json().candidates.length, MAX_MAPPING_CANDIDATES);
      servedConforms('/v1/needs/{id}/mapping-candidates', 'get', response, 'a truncated candidate list');
    });

    const created = scriptedScope({ need: OPEN_NEED, product: VERIFIED_CATALOGUE[0]!, catalogue: VERIFIED_CATALOGUE });
    await withMappingRoutes(created.scope, async (app) => {
      const response = await app.inject({ method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS, payload: SELECTION });
      assert.equal(response.statusCode, 201, response.body);
      servedConforms('/v1/needs/{id}/mapping', 'post', response, 'a new mapping decision');
    });

    const authoritative = scriptedScope({
      need: { ...OPEN_NEED, sourceRef: `${MAPPING_IDS.installation}:D-1` },
      authoritativeUnits: ['box'],
      product: VERIFIED_CATALOGUE[1]!,
      catalogue: VERIFIED_CATALOGUE,
    });
    await withMappingRoutes(authoritative.scope, async (app) => {
      const response = await app.inject({ method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS,
        payload: { needVersion: 1, productId: MAPPING_IDS.otherProduct } });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().unitBasis, 'authoritative_metadata');
      servedConforms('/v1/needs/{id}/mapping', 'post', response, 'a decision carried by authoritative metadata');
    });

    const repeated = scriptedScope({
      need: { ...OPEN_NEED, version: 2, sourceMapId: MAPPING_IDS.map },
      product: VERIFIED_CATALOGUE[0]!,
      existingDecision: { map_id: MAPPING_IDS.map, decision_id: MAPPING_IDS.decision, unit: 'box', unit_basis: 'explicit_supplied_unit' },
    });
    await withMappingRoutes(repeated.scope, async (app) => {
      const response = await app.inject({ method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS, payload: { ...SELECTION, needVersion: 2 } });
      assert.equal(response.statusCode, 200, response.body);
      servedConforms('/v1/needs/{id}/mapping', 'post', response, 'an idempotent repeat');
    });
  });

  test('every mapping refusal is a documented status carrying the documented envelope', async () => {
    const statuses = new Set<number>();
    for (const refusal of MAPPING_REFUSALS) {
      const { scope } = scriptedScope(refusal.world, refusal.tenant ?? mappingContext());
      await withMappingRoutes(scope, async (app) => {
        const [path, method, response] = refusal.write
          ? ['/v1/needs/{id}/mapping', 'post' as const, await app.inject({ method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS, payload: refusal.payload ?? SELECTION })]
          : ['/v1/needs/{id}/mapping-candidates', 'get' as const, await app.inject({ url: MAPPING_CANDIDATES_URL, headers: MAPPING_HEADERS })];
        assert.equal(response.statusCode, refusal.status, `${refusal.name}: ${response.body}`);
        servedConforms(path, method, response, refusal.name);
        statuses.add(response.statusCode);
      });
    }

    const boundary: readonly [string, TenantScope | undefined, InjectOptions, string, 'get' | 'post', number][] = [
      ['an unknown command field', undefined, { method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS, payload: { ...SELECTION, autoSelect: true } }, '/v1/needs/{id}/mapping', 'post', 400],
      ['malformed JSON', undefined, { method: 'POST', url: MAPPING_BIND_URL, headers: { ...MAPPING_HEADERS, 'content-type': 'application/json' }, payload: '{"needVersion":1,' }, '/v1/needs/{id}/mapping', 'post', 400],
      ['a malformed need identifier', scriptedScope({ need: OPEN_NEED }).scope, { url: '/v1/needs/not-a-uuid/mapping-candidates', headers: MAPPING_HEADERS }, '/v1/needs/{id}/mapping-candidates', 'get', 400],
      ['an anonymous read', undefined, { url: MAPPING_CANDIDATES_URL }, '/v1/needs/{id}/mapping-candidates', 'get', 401],
      ['an anonymous write', undefined, { method: 'POST', url: MAPPING_BIND_URL, payload: SELECTION }, '/v1/needs/{id}/mapping', 'post', 401],
      ['a denied membership', () => Promise.reject(new MembershipAccessDeniedError()), { url: MAPPING_CANDIDATES_URL, headers: MAPPING_HEADERS }, '/v1/needs/{id}/mapping-candidates', 'get', 403],
      ['an unexpected failure', scriptedScope({ need: OPEN_NEED, failure: new Error('password authentication failed') }).scope,
        { method: 'POST', url: MAPPING_BIND_URL, headers: MAPPING_HEADERS, payload: SELECTION }, '/v1/needs/{id}/mapping', 'post', 500],
    ];
    for (const [because, scope, request, path, method, status] of boundary) {
      await withMappingRoutes(scope, async (app) => {
        const response = await app.inject(request);
        assert.equal(response.statusCode, status, `${because}: ${response.body}`);
        servedConforms(path, method, response, because);
        assert.doesNotMatch(response.body, /password|autoSelect|not-a-uuid/, because);
        statuses.add(response.statusCode);
      });
    }
    // Every refusal status the two routes produce was observed and is documented; 413 is shared boundary
    // behaviour already covered above.
    assert.deepEqual([...statuses].sort(), [400, 401, 403, 404, 409, 422, 500]);
  });

  test('the documented list and mapping bounds are the repository bounds', () => {
    type Node = { properties: Record<string, Node>; items: Node; maxItems: number; maximum: number; maxLength: number };
    const schema = (name: string) => document.components.schemas[name] as unknown as Node;
    const candidates = schema('MappingCandidates');
    assert.equal(candidates.properties.candidates!.maxItems, MAX_MAPPING_CANDIDATES);
    assert.equal(candidates.properties.unselectableExcluded!.maximum, MAX_MAPPING_CANDIDATES + 1);
    for (const page of ['NeedPage', 'OrderPage']) {
      assert.equal(schema(page).properties.items!.maxItems, MAX_LIMIT, `${page} items`);
      assert.equal(schema(page).properties.nextCursor!.maxLength, MAX_CURSOR_LENGTH, `${page} cursor`);
    }
    assert.equal(schema('NeedPage').properties.items!.items.properties.saleUnit!.maxLength, MAX_SALE_UNIT_LENGTH);
    for (const operationId of ['listNeeds', 'listOrders']) {
      const operation = Object.values(document.paths).flatMap((methods) => Object.values(methods)).find((candidate) => candidate.operationId === operationId);
      const parameters = (operation as unknown as { parameters: { name: string; schema: { maxLength?: number; enum?: string[] } }[] }).parameters;
      assert.equal(parameters.find((parameter) => parameter.name === 'cursor')?.schema.maxLength, MAX_CURSOR_LENGTH);
      // Every documented status is one the route accepts; parseListQuery refuses anything else.
      for (const status of parameters.find((parameter) => parameter.name === 'status')?.schema.enum ?? []) {
        assert.doesNotThrow(() => parseListQuery(operationId === 'listNeeds' ? 'needs' : 'orders', { status }), `${operationId} ${status}`);
      }
    }
  });
});
