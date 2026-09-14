import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { approvalCommandSchema, mappingCommandSchema, receiptCommandSchema, renderOpenapi } from '../scripts/openapi.ts';
import { inventoryCommandSchema } from '../src/inventory-schema.ts';
import { quoteCommandSchema } from '../src/quote-schema.ts';
import { isUtcInstant } from '../src/submission.ts';

type Schema = Record<string, unknown>;
type ResponseObject = { description: string; headers: Schema; content: { 'application/json': { schema: Schema } } };
type Operation = {
  operationId: string;
  description?: string;
  security?: unknown[];
  parameters?: Schema[];
  requestBody?: { required: boolean; content: { 'application/json': { schema: Schema } } };
  responses: Record<string, ResponseObject>;
};
type Document = {
  openapi: string;
  info: Schema;
  security: unknown[];
  components: { securitySchemes: Schema; schemas: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};

const document = JSON.parse(renderOpenapi()) as Document;

// The API emits lowercase canonical UUIDs from PostgreSQL uuid columns and randomUUID(); the version and
// variant nibbles are not constrained by the selector the routes accept, so the format stays hex-only.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// allowUnionTypes is required because OpenAPI 3.1 expresses a nullable field as a JSON Schema type array.
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uuid: (value: string) => UUID.test(value), 'date-time': isUtcInstant },
});

function component(name: string): Schema {
  const schema = document.components.schemas[name];
  assert.ok(schema, `components.schemas.${name} is missing: every success response must name a concrete contract`);
  return schema;
}

const validate = (name: string) => ajv.compile(component(name));

function accept(name: string, payload: unknown, because: string): void {
  const validator = validate(name);
  assert.equal(validator(payload), true, `${name} rejected ${because}: ${ajv.errorsText(validator.errors)}`);
}

function reject(name: string, payload: unknown, because: string): void {
  const validator = validate(name);
  assert.equal(validator(payload), false, `${name} accepted ${because}`);
}

const ERROR_CODES = [400, 401, 403, 404, 409, 413, 422, 500] as const;
const OPERATIONS = [
  { path: '/health', method: 'get', operationId: 'getHealth', success: { 200: 'HealthStatus' }, authenticated: false, scoped: false },
  { path: '/openapi.json', method: 'get', operationId: 'getOpenapi', success: { 200: 'OpenapiDocument' }, authenticated: false, scoped: false },
  { path: '/v1/context', method: 'get', operationId: 'getContext', success: { 200: 'TenantContext' }, authenticated: true, scoped: true },
  { path: '/v1/needs', method: 'get', operationId: 'listNeeds', success: { 200: 'NeedPage' }, authenticated: true, scoped: true },
  { path: '/v1/needs/{id}', method: 'get', operationId: 'getNeed', success: { 200: 'NeedView' }, authenticated: true, scoped: true },
  { path: '/v1/needs/{id}/mapping-candidates', method: 'get', operationId: 'getMappingCandidates', success: { 200: 'MappingCandidates' }, authenticated: true, scoped: true },
  { path: '/v1/needs/{id}/mapping', method: 'post', operationId: 'bindNeedMapping', success: { 200: 'MappingResult', 201: 'MappingResult' }, authenticated: true, scoped: true },
  // Inventory scope is derived from the verified subject's installation, so it carries no scope headers.
  { path: '/v1/inventory', method: 'post', operationId: 'ingestInventory', success: { 202: 'InventoryAcceptance' }, authenticated: true, scoped: false },
  { path: '/v1/quotes', method: 'post', operationId: 'createQuote', success: { 201: 'Quote' }, authenticated: true, scoped: true },
  { path: '/v1/quotes/{id}/approve', method: 'post', operationId: 'approveQuote', success: { 200: 'ApprovalResult', 202: 'ApprovalResult' }, authenticated: true, scoped: true },
  { path: '/v1/orders', method: 'get', operationId: 'listOrders', success: { 200: 'OrderPage' }, authenticated: true, scoped: true },
  { path: '/v1/orders/{id}', method: 'get', operationId: 'getOrder', success: { 200: 'OrderDetail' }, authenticated: true, scoped: true },
  { path: '/v1/orders/{id}/receipts', method: 'post', operationId: 'confirmReceipt', success: { 200: 'ReceiptAcknowledgement' }, authenticated: true, scoped: true },
] as const;

type OperationId = (typeof OPERATIONS)[number]['operationId'];

const operation = (entry: (typeof OPERATIONS)[number]): Operation => {
  const found = document.paths[entry.path]?.[entry.method];
  assert.ok(found, `${entry.method.toUpperCase()} ${entry.path} is missing from the generated document`);
  return found;
};

const byOperationId = (operationId: OperationId): Operation => {
  const entry = OPERATIONS.find((candidate) => candidate.operationId === operationId);
  assert.ok(entry, `${operationId} is not a documented operation`);
  return operation(entry);
};

/*
 * SYNTHETIC EXAMPLES — NOT CAPTURED DATABASE RESPONSES.
 *
 * Every value below is invented or copied from the synthetic fixture graph in packages/db/test
 * (organisation 1000…01, branch 2000…01, need 4000…01 'SYN-A' quantity 2, offer 12.35 EGP, partial
 * acknowledgement 1 accepted / 1 rejected). They illustrate the shapes the current handlers build.
 * Only apps/api/test/response-contracts.test.ts validates responses that a real server produced, and
 * only for the two endpoints buildApp serves without PostgreSQL. The tenant contracts below remain
 * unverified against a real database until the coordinator runs the integration suites; see
 * docs/testing/openapi-responses.md.
 */
const ids = {
  organisation: '10000000-0000-4000-8000-000000000001',
  supplier: '10000000-0000-4000-8000-000000000003',
  branch: '20000000-0000-4000-8000-000000000001',
  membership: '30000000-0000-4000-8000-000000000001',
  need: '40000000-0000-4000-8000-000000000001',
  product: '60000000-0000-4000-8000-000000000001',
  map: '70000000-0000-4000-8000-000000000001',
  offer: '90000000-0000-4000-8000-000000000001',
  quote: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d01',
  approval: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d02',
  intent: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d03',
  line: 'c41a0f2b-77d3-4c1e-8a90-5b6c7d8e9f01',
  receipt: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d04',
};

const identityExample = {
  brand: 'SYN Brand',
  manufacturer: 'SYN Maker',
  strength: '5 mg',
  dosageForm: 'tablet',
  packSize: { value: '20', unit: 'tablet' },
  saleUnit: 'box',
};

const contextExample = {
  principalKind: 'member',
  userSubject: 'synthetic:user:a',
  membershipId: ids.membership,
  organisationId: ids.organisation,
  organisationKind: 'pharmacy',
  branchId: ids.branch,
  allowedBranchIds: [ids.branch],
  role: 'pharmacy_owner',
  membershipVersion: 1,
};

const needExample = { id: ids.need, productRef: 'SYN-A', quantity: '2', status: 'open', version: 1 };

const inventoryExample = { eventId: 'event-1', status: 'processed', duplicate: false, projectionRevision: 3 };

const quoteLineExample = {
  needId: ids.need,
  needVersion: 1,
  quantity: '2',
  unit: 'box',
  mapId: ids.map,
  mapVersion: 1,
  productId: ids.product,
  identity: identityExample,
  offerId: ids.offer,
  offerVersion: 1,
  termsVersion: 1,
  supplierId: ids.supplier,
  gross: '24.7',
  discount: '0',
  tax: '0',
  fees: '0',
  net: '24.7',
};

const quoteExample = {
  id: ids.quote,
  version: 1,
  status: 'quoted',
  bindingStatus: 'binding',
  currency: 'EGP',
  expiresAt: '2026-09-13T09:35:00.000Z',
  pricingRuleVersion: 'synthetic-cash-tax-exempt-v1',
  termsHash: '3b'.repeat(32),
  lines: [quoteLineExample],
  unmetLines: [],
  total: '24.7',
};

const approvalExample = {
  approvalId: ids.approval,
  quoteId: ids.quote,
  quoteVersion: 1,
  status: 'queued',
  orderIntentIds: [ids.intent],
};

const orderLineExample = {
  id: ids.line,
  productIdentity: identityExample,
  ordered: '2',
  accepted: '1',
  rejected: '1',
  shipped: '1',
  received: '1',
};

const orderExample = {
  id: ids.intent,
  state: 'acknowledged',
  externalClientRef: `pc-syn-${ids.intent}`,
  externalOrderId: 'syn-1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6071',
  version: 4,
  lines: [orderLineExample],
  uncertainty: null,
};

const receiptExample = { id: ids.receipt };

const needSummaryExample = {
  id: ids.need,
  productRef: 'SYN-A',
  quantity: '2.500',
  outstandingQuantity: '2.500',
  status: 'open',
  version: 1,
  mappingStatus: 'verified',
  productId: ids.product,
  saleUnit: 'box',
};

const needPageExample = { items: [needSummaryExample], nextCursor: 'eyJ2IjoxLCJzIjoiYWJjIiwiYSI6IjQwMDAifQ' };

const orderSummaryExample = {
  id: ids.intent,
  state: 'queued',
  version: 1,
  externalClientRef: `pc-syn-${ids.intent}`,
  externalOrderId: null,
  lines: { total: 0, settled: 0, awaitingReceipt: 0 },
  uncertainty: null,
};

const orderPageExample = { items: [orderSummaryExample], nextCursor: null };

const candidatesExample = {
  needId: ids.need,
  needVersion: 1,
  needStatus: 'open',
  productRef: 'SYN-C',
  currentProductId: null,
  authoritativeUnit: null,
  unitBasis: 'explicit_supplied_unit_required',
  selectionRequired: true,
  ambiguous: true,
  truncated: false,
  unselectableExcluded: 1,
  candidates: [
    { productId: ids.product, identity: identityExample },
    { productId: '60000000-0000-4000-8000-000000000002', identity: { ...identityExample, strength: '10 mg' } },
  ],
};

const mappingResultExample = {
  needId: ids.need,
  needVersion: 2,
  mapId: ids.map,
  productId: ids.product,
  mapStatus: 'verified',
  unit: 'box',
  unitBasis: 'explicit_supplied_unit',
  decisionId: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d05',
  repeated: false,
};

const envelopeExample = {
  error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', correlationId: ids.quote },
};

function checkedValues(file: string, pattern: RegExp): string[] {
  const source = readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8');
  const match = pattern.exec(source);
  assert.ok(match, `${file} no longer declares ${String(pattern)}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((found) => found[1]!);
}

describe('OpenAPI success response contracts', () => {
  test('every operation names a concrete success contract instead of a generic object', () => {
    assert.deepEqual(Object.keys(document.paths), OPERATIONS.map((entry) => entry.path));
    for (const entry of OPERATIONS) {
      const found = operation(entry);
      assert.equal(found.operationId, entry.operationId);
      const successCodes = Object.keys(found.responses).filter((code) => Number(code) < 300);
      assert.deepEqual(successCodes, Object.keys(entry.success), `${entry.operationId} success codes`);
      for (const [code, name] of Object.entries(entry.success)) {
        const schema = found.responses[code]!.content['application/json'].schema;
        assert.deepEqual(schema, { $ref: `#/components/schemas/${name}` }, `${entry.operationId} ${code} schema`);
        assert.notDeepEqual(component(name), { type: 'object' }, `${name} is still the generic success object`);
      }
    }
  });

  test('named success contracts refuse unknown top level fields', () => {
    const named = new Set(OPERATIONS.flatMap((entry) => Object.values(entry.success)));
    assert.equal(named.size, 13);
    for (const name of named) {
      const schema = component(name);
      assert.equal(schema.type, 'object', `${name} type`);
      assert.equal(schema.additionalProperties, false, `${name} must refuse unknown fields`);
      assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${name} must require its fields`);
    }
  });

  test('the common error envelope stays strict while the code stays extensible', () => {
    accept('ErrorEnvelope', envelopeExample, 'the redacted 404 envelope');
    // Inventory refusals surface the domain rejection reason verbatim, which is lower case snake case,
    // so the envelope must not narrow the code to an upper case enumeration.
    accept('ErrorEnvelope', { error: { ...envelopeExample.error, code: 'stale_sequence' } }, 'a domain refusal reason');
    accept('ErrorEnvelope', { error: { ...envelopeExample.error, code: 'IDEMPOTENCY_KEY_SCOPE_CONFLICT' } }, 'a procurement refusal code');
    reject('ErrorEnvelope', { error: { ...envelopeExample.error, code: '' } }, 'an empty code');
    reject('ErrorEnvelope', { error: { ...envelopeExample.error, code: 'not a code' } }, 'a code with spaces');
    reject('ErrorEnvelope', { error: { code: 'NOT_FOUND', message: 'x' } }, 'a missing correlation identifier');
    reject('ErrorEnvelope', { error: { ...envelopeExample.error, correlationId: 'attacker-controlled' } }, 'a non UUID correlation identifier');
    reject('ErrorEnvelope', { error: { ...envelopeExample.error, stack: 'at handler' } }, 'a leaked stack field');
    reject('ErrorEnvelope', { ...envelopeExample, detail: 'x' }, 'an extra envelope member');
  });

  test('every response keeps the redacted error set and the correlation header', () => {
    for (const entry of OPERATIONS) {
      const found = operation(entry);
      const failures = Object.keys(found.responses).filter((code) => Number(code) >= 300);
      assert.deepEqual(failures, ERROR_CODES.map(String), `${entry.operationId} error codes`);
      for (const [code, response] of Object.entries(found.responses)) {
        assert.deepEqual(response.headers, { 'X-Correlation-Id': { required: true, schema: { type: 'string', format: 'uuid' } } },
          `${entry.operationId} ${code} headers`);
        if (Number(code) >= 300) {
          assert.equal(response.description, 'Redacted error');
          assert.deepEqual(response.content['application/json'].schema, { $ref: '#/components/schemas/ErrorEnvelope' }, `${entry.operationId} ${code} envelope`);
        }
      }
    }
  });

  test('security, scope headers and request bodies are preserved', () => {
    assert.deepEqual(document.security, [{ oidc: [] }]);
    assert.deepEqual(document.components.securitySchemes, { oidc: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } });
    const scope = ['X-Organisation-Id', 'X-Branch-Id'].map((name) => ({ name, in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }));
    for (const entry of OPERATIONS) {
      const found = operation(entry);
      assert.equal(found.security === undefined, entry.authenticated, `${entry.operationId} security`);
      if (!entry.authenticated) assert.deepEqual(found.security, []);
      const headers = (found.parameters ?? []).filter((parameter) => String(parameter.name).startsWith('X-'));
      assert.deepEqual(headers, entry.scoped ? scope : [], `${entry.operationId} scope headers`);
    }
    const body = (operationId: OperationId) => byOperationId(operationId).requestBody?.content['application/json'].schema;
    assert.deepEqual(body('ingestInventory'), inventoryCommandSchema);
    assert.deepEqual(body('createQuote'), quoteCommandSchema);
    assert.deepEqual(body('approveQuote'), approvalCommandSchema);
    assert.deepEqual(body('confirmReceipt'), receiptCommandSchema);
    assert.deepEqual(body('bindNeedMapping'), mappingCommandSchema);
    assert.equal(byOperationId('bindNeedMapping').requestBody?.required, true);
    for (const entry of OPERATIONS) {
      if (entry.method === 'get') assert.equal(operation(entry).requestBody, undefined, `${entry.operationId} must not document a body`);
    }
    assert.deepEqual(byOperationId('approveQuote').parameters?.find((parameter) => parameter.name === 'Idempotency-Key'),
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } });
  });

  test('the mapping command contract refuses unknown, loose and unbounded fields', () => {
    const command = ajv.compile(mappingCommandSchema);
    assert.equal(command({ needVersion: 1, productId: ids.product }), true, 'a selection without a supplied unit');
    assert.equal(command({ needVersion: 1, productId: ids.product, suppliedUnit: 'box' }), true, 'a selection with a supplied unit');
    for (const [payload, because] of [
      [{ productId: ids.product }, 'a missing need version'],
      [{ needVersion: 1 }, 'a missing product'],
      [{ needVersion: 0, productId: ids.product }, 'a non positive version'],
      [{ needVersion: '1', productId: ids.product }, 'a string version'],
      [{ needVersion: 1, productId: '6000000A-0000-4000-8000-00000000000B' }, 'an upper case product identity'],
      [{ needVersion: 1, productId: ids.product, suppliedUnit: '' }, 'an empty supplied unit'],
      [{ needVersion: 1, productId: ids.product, suppliedUnit: 'x'.repeat(33) }, 'an oversized supplied unit'],
      [{ needVersion: 1, productId: ids.product, organisationId: ids.organisation }, 'a smuggled tenant selector'],
      [{ needVersion: 1, productId: ids.product, autoSelect: true }, 'an automatic selection flag'],
    ] as const) {
      assert.equal(command(payload), false, `the mapping command accepted ${because}`);
    }
  });

  test('list operations document exactly the bounded query contract the routes accept', () => {
    const needStatus = checkedValues('0001_identity_and_tenant_isolation.sql', /DEFAULT 'open' CHECK \(status IN \(([^)]*)\)\)/);
    const orderState = checkedValues('0007_transactional_procurement.sql', /state text NOT NULL CHECK\(state IN \(([^)]*)\)\)/);
    const query = (operationId: OperationId) => (byOperationId(operationId).parameters ?? []).filter((parameter) => parameter.in === 'query');
    const expected = (statuses: readonly string[]) => [
      { name: 'limit', in: 'query', required: false, schema: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' } },
      { name: 'status', in: 'query', required: false, schema: { enum: statuses } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' } },
    ];
    const strip = (parameters: Schema[]) =>
      parameters.map((parameter) => Object.fromEntries(Object.entries(parameter).filter(([key]) => key !== 'description')));
    assert.deepEqual(strip(query('listNeeds')), expected(needStatus));
    assert.deepEqual(strip(query('listOrders')), expected(orderState));
    for (const parameter of [...query('listNeeds'), ...query('listOrders')]) {
      assert.equal(typeof parameter.description, 'string', `${String(parameter.name)} must be described`);
    }
    for (const entry of OPERATIONS) {
      if (entry.operationId !== 'listNeeds' && entry.operationId !== 'listOrders') assert.deepEqual(query(entry.operationId), [], `${entry.operationId} query`);
    }
    const limit = new RegExp((query('listNeeds')[0]!.schema as { pattern: string }).pattern);
    for (const accepted of ['1', '25', '99', '100']) assert.equal(limit.test(accepted), true, accepted);
    for (const refused of ['0', '101', '007', '1.0', '-1', '1e2', '']) assert.equal(limit.test(refused), false, refused);
  });

  test('every new operation states the role it requires', () => {
    assert.match(String(byOperationId('listNeeds').description), /pharmacy_owner or purchaser/);
    assert.match(String(byOperationId('listOrders').description), /pharmacy_owner or purchaser/);
    assert.match(String(byOperationId('getMappingCandidates').description), /pharmacy_owner or purchaser/);
    assert.match(String(byOperationId('bindNeedMapping').description), /pharmacy_owner only/);
  });

  test('health and the served document validate their own contracts', () => {
    accept('HealthStatus', { status: 'ok' }, 'the only health body the route builds');
    reject('HealthStatus', { status: 'degraded' }, 'an undocumented status');
    reject('HealthStatus', {}, 'a missing status');
    reject('HealthStatus', { status: 'ok', uptime: 12 }, 'an extra diagnostic field');
    accept('OpenapiDocument', document, 'the generated document itself');
    reject('OpenapiDocument', { ...document, openapi: '3.0.3' }, 'a different OpenAPI version');
    reject('OpenapiDocument', { ...document, paths: undefined }, 'a document without paths');
  });

  test('tenant context publishes the resolved role and branch scope only', () => {
    accept('TenantContext', contextExample, 'the resolved member context');
    accept('TenantContext', { ...contextExample, organisationKind: 'supplier', role: 'supplier_operator' }, 'a supplier member');
    reject('TenantContext', { ...contextExample, principalKind: 'service' }, 'an undocumented principal kind');
    reject('TenantContext', { ...contextExample, role: 'owner' }, 'the retired owner role');
    reject('TenantContext', { ...contextExample, allowedBranchIds: [] }, 'an empty branch scope');
    reject('TenantContext', { ...contextExample, allowedBranchIds: [ids.branch, ids.organisation] }, 'a widened branch scope');
    reject('TenantContext', { ...contextExample, membershipVersion: 0 }, 'a non positive membership version');
    reject('TenantContext', { ...contextExample, accessToken: 'header.payload.signature' }, 'a leaked credential field');
    reject('TenantContext', { ...contextExample, userSubject: undefined }, 'a missing subject');
  });

  test('need view reports the outstanding remainder as stored numeric text', () => {
    accept('NeedView', needExample, 'an open need');
    accept('NeedView', { ...needExample, quantity: '7.500', status: 'covered' }, 'numeric text that kept its stored scale');
    reject('NeedView', { ...needExample, quantity: 2 }, 'a numeric quantity instead of exact text');
    reject('NeedView', { ...needExample, quantity: '1e3' }, 'an exponent quantity');
    reject('NeedView', { ...needExample, quantity: '-1' }, 'a negative quantity');
    reject('NeedView', { ...needExample, status: 'draft' }, 'an undocumented status');
    reject('NeedView', { ...needExample, sourceRef: `${ids.branch}:00017` }, 'a leaked source reference');
    reject('NeedView', { id: ids.need, productRef: 'SYN-A', quantity: '2', status: 'open' }, 'a missing version');
  });

  test('inventory acceptance echoes the durable outcome of the event', () => {
    accept('InventoryAcceptance', inventoryExample, 'a processed event');
    accept('InventoryAcceptance', { ...inventoryExample, duplicate: true }, 'a replayed event');
    accept('InventoryAcceptance', { ...inventoryExample, projectionRevision: 0 }, 'a complete event that changed no projection');
    reject('InventoryAcceptance', { ...inventoryExample, status: 'queued' }, 'a status the route never returns');
    reject('InventoryAcceptance', { ...inventoryExample, duplicate: 'false' }, 'a string duplicate flag');
    reject('InventoryAcceptance', { ...inventoryExample, projectionRevision: -1 }, 'a negative revision');
    reject('InventoryAcceptance', { ...inventoryExample, projectionRevision: 1.5 }, 'a fractional revision');
    reject('InventoryAcceptance', { ...inventoryExample, installationId: ids.branch }, 'a leaked installation identifier');
    reject('InventoryAcceptance', { eventId: 'event-1', status: 'processed', duplicate: false }, 'a missing projection revision');
  });

  test('quote publishes binding commercial terms with canonical decimal strings', () => {
    accept('Quote', quoteExample, 'a binding single line quote');
    reject('Quote', { ...quoteExample, total: '24.70' }, 'a non canonical total');
    reject('Quote', { ...quoteExample, total: 24.7 }, 'a binary floating point total');
    reject('Quote', { ...quoteExample, status: 'approved' }, 'a status creation never returns');
    reject('Quote', { ...quoteExample, bindingStatus: 'indicative' }, 'an unbinding quote');
    reject('Quote', { ...quoteExample, currency: 'USD' }, 'a currency the schema and database refuse');
    reject('Quote', { ...quoteExample, pricingRuleVersion: 'production-v1' }, 'a pricing rule the fixtures never apply');
    reject('Quote', { ...quoteExample, expiresAt: '2026-09-13T12:35:00+03:00' }, 'a non UTC expiry');
    reject('Quote', { ...quoteExample, termsHash: 'not-a-digest' }, 'a malformed terms digest');
    reject('Quote', { ...quoteExample, lines: [] }, 'a quote without lines');
    reject('Quote', { ...quoteExample, unmetLines: [{ needId: ids.need }] }, 'unmet lines the API refuses instead of returning');
    reject('Quote', { ...quoteExample, organisationId: ids.organisation }, 'a leaked tenant identifier');
    reject('Quote', { ...quoteExample, lines: [{ ...quoteLineExample, net: '' }] }, 'an empty line net amount');
    reject('Quote', { ...quoteExample, lines: [{ ...quoteLineExample, identity: { brand: 'SYN Brand' } }] }, 'an identity without its sale unit');
    reject('Quote', { ...quoteExample, lines: [{ ...quoteLineExample, offerId: undefined }] }, 'a line without its offer identity');
    reject('Quote', { ...quoteExample, lines: [{ ...quoteLineExample, unitPrice: '12.35' }] }, 'an undocumented line field');
  });

  test('approval result names the approval and every queued order intent', () => {
    accept('ApprovalResult', approvalExample, 'a newly queued approval');
    accept('ApprovalResult', { ...approvalExample, orderIntentIds: [ids.intent, ids.quote] }, 'one intent per supplier');
    reject('ApprovalResult', { ...approvalExample, status: 'approved' }, 'a status the handler never builds');
    reject('ApprovalResult', { ...approvalExample, orderIntentIds: [] }, 'an approval without order intents');
    reject('ApprovalResult', { ...approvalExample, orderIntentIds: [ids.intent, ids.intent] }, 'duplicated intent identifiers');
    reject('ApprovalResult', { ...approvalExample, quoteVersion: 0 }, 'a non positive quote version');
    reject('ApprovalResult', { ...approvalExample, idempotencyKey: 'parallel-a' }, 'a leaked idempotency key');
    reject('ApprovalResult', { approvalId: ids.approval, quoteId: ids.quote, status: 'queued', orderIntentIds: [ids.intent] }, 'a missing quote version');
  });

  test('order detail carries per line quantities and the uncertainty shape', () => {
    accept('OrderDetail', orderExample, 'a partially accepted acknowledged order');
    accept('OrderDetail', { ...orderExample, state: 'queued', externalOrderId: null, version: 1, lines: [], uncertainty: null },
      'a queued order whose lines are not materialised yet');
    accept('OrderDetail', { ...orderExample, state: 'outcome_unknown', externalOrderId: null, uncertainty: { safeToRetry: false, nextAction: 'reconciliation_required' } },
      'an order awaiting reconciliation');
    accept('OrderDetail', { ...orderExample, lines: [{ ...orderLineExample, received: '1.0' }] }, 'a received sum that kept its numeric scale');
    reject('OrderDetail', { ...orderExample, uncertainty: { safeToRetry: true, nextAction: 'reconciliation_required' } }, 'a retryable uncertain outcome');
    reject('OrderDetail', { ...orderExample, uncertainty: { safeToRetry: false } }, 'an uncertainty without its next action');
    reject('OrderDetail', { ...orderExample, uncertainty: { safeToRetry: false, nextAction: 'retry' } }, 'an undocumented next action');
    reject('OrderDetail', { ...orderExample, state: 'delivered' }, 'a state the database refuses');
    reject('OrderDetail', { ...orderExample, externalOrderId: undefined }, 'a missing external order identity');
    reject('OrderDetail', { ...orderExample, supplierId: ids.supplier }, 'a leaked supplier identifier');
    reject('OrderDetail', { ...orderExample, lines: [{ ...orderLineExample, accepted: undefined }] }, 'a line without its accepted quantity');
    reject('OrderDetail', { ...orderExample, lines: [{ ...orderLineExample, shipped: -1 }] }, 'a numeric shipped quantity');
    reject('OrderDetail', { ...orderExample, lines: [{ ...orderLineExample, needId: ids.need }] }, 'an undocumented line field');
  });

  test('receipt acknowledgement returns the stable receipt identity only', () => {
    accept('ReceiptAcknowledgement', receiptExample, 'a confirmed receipt');
    reject('ReceiptAcknowledgement', {}, 'a missing receipt identity');
    reject('ReceiptAcknowledgement', { id: 'receipt-stable' }, 'the client reference instead of the identity');
    reject('ReceiptAcknowledgement', { ...receiptExample, reference: 'receipt-stable' }, 'an echoed client reference');
    reject('ReceiptAcknowledgement', { ...receiptExample, lines: [] }, 'an undocumented lines field');
  });

  test('need page reports verified identity only and never a count or a fabricated quantity', () => {
    accept('NeedPage', needPageExample, 'a page with a verified mapping and a continuation');
    accept('NeedPage', { items: [], nextCursor: null }, 'an empty last page');
    const unmapped = { ...needSummaryExample, mappingStatus: 'unmapped', productId: null, saleUnit: null };
    accept('NeedPage', { items: [unmapped], nextCursor: null }, 'an unmapped need');
    accept('NeedPage', { items: [{ ...unmapped, status: 'quoted', outstandingQuantity: null }], nextCursor: null }, 'a quoted need with no recorded outstanding reading');
    accept('NeedPage', { items: [{ ...needSummaryExample, status: 'closed', quantity: '4', outstandingQuantity: '0' }], nextCursor: null }, 'a closed need');
    reject('NeedPage', { ...needPageExample, total: 1 }, 'a cross tenant count');
    reject('NeedPage', { items: [needSummaryExample] }, 'a missing continuation member');
    reject('NeedPage', { ...needPageExample, nextCursor: '' }, 'an empty cursor');
    reject('NeedPage', { ...needPageExample, nextCursor: 'not base64url!' }, 'a cursor outside base64url');
    reject('NeedPage', { ...needPageExample, nextCursor: 'a'.repeat(513) }, 'an oversized cursor');
    reject('NeedPage', { items: Array.from({ length: 101 }, () => needSummaryExample), nextCursor: null }, 'more than the maximum page');
    reject('NeedPage', { items: [{ ...needSummaryExample, quantity: 2.5 }], nextCursor: null }, 'a numeric quantity');
    reject('NeedPage', { items: [{ ...needSummaryExample, outstandingQuantity: 2.5 }], nextCursor: null }, 'a numeric outstanding quantity');
    reject('NeedPage', { items: [{ ...needSummaryExample, outstandingQuantity: '-1' }], nextCursor: null }, 'a negative outstanding quantity');
    reject('NeedPage', { items: [{ ...needSummaryExample, mappingStatus: 'automatic' }], nextCursor: null }, 'an undocumented mapping status');
    reject('NeedPage', { items: [{ ...needSummaryExample, productId: 'SYN Brand' }], nextCursor: null }, 'a product identity that is not a uuid');
    reject('NeedPage', { items: [{ ...needSummaryExample, saleUnit: '' }], nextCursor: null }, 'an empty sale unit');
    reject('NeedPage', { items: [{ ...needSummaryExample, organisationId: ids.organisation }], nextCursor: null }, 'a leaked tenant identifier');
    reject('NeedPage', { items: [{ ...needSummaryExample, sourceMapId: ids.map }], nextCursor: null }, 'a leaked mapping row identity');
    const missing = Object.fromEntries(Object.entries(needSummaryExample).filter(([key]) => key !== 'outstandingQuantity'));
    reject('NeedPage', { items: [missing], nextCursor: null }, 'an item without its outstanding reading');
  });

  test('order page reports line counts and uncertainty without counterparty or pricing', () => {
    accept('OrderPage', orderPageExample, 'a queued order summary');
    accept('OrderPage', { items: [{ ...orderSummaryExample, state: 'outcome_unknown', version: 3, lines: { total: 2, settled: 0, awaitingReceipt: 0 },
      uncertainty: { safeToRetry: false, nextAction: 'reconciliation_required' } }], nextCursor: 'abc_DEF-1' }, 'an order awaiting reconciliation');
    accept('OrderPage', { items: [{ ...orderSummaryExample, state: 'acknowledged', externalOrderId: 'syn-1', lines: { total: 3, settled: 1, awaitingReceipt: 2 } }], nextCursor: null },
      'an acknowledged order');
    reject('OrderPage', { ...orderPageExample, count: 1 }, 'a cross tenant count');
    reject('OrderPage', { items: [{ ...orderSummaryExample, supplierId: ids.supplier }], nextCursor: null }, 'a leaked counterparty');
    reject('OrderPage', { items: [{ ...orderSummaryExample, total: '24.7' }], nextCursor: null }, 'a leaked price total');
    reject('OrderPage', { items: [{ ...orderSummaryExample, lines: { total: 1, settled: 0, awaitingReceipt: 0, quantity: '2' } }], nextCursor: null }, 'a summed quantity');
    reject('OrderPage', { items: [{ ...orderSummaryExample, lines: { total: -1, settled: 0, awaitingReceipt: 0 } }], nextCursor: null }, 'a negative count');
    reject('OrderPage', { items: [{ ...orderSummaryExample, lines: { total: '1', settled: 0, awaitingReceipt: 0 } }], nextCursor: null }, 'a string count');
    reject('OrderPage', { items: [{ ...orderSummaryExample, state: 'delivered' }], nextCursor: null }, 'a state the database refuses');
    reject('OrderPage', { items: [{ ...orderSummaryExample, uncertainty: { safeToRetry: true, nextAction: 'reconciliation_required' } }], nextCursor: null }, 'a retryable uncertainty');
    reject('OrderPage', { items: [{ ...orderSummaryExample, externalOrderId: '' }], nextCursor: null }, 'an empty external order identity');
  });

  test('mapping candidates carry pack identity only and always await a human selection', () => {
    accept('MappingCandidates', candidatesExample, 'an ambiguous candidate list');
    accept('MappingCandidates', { ...candidatesExample, authoritativeUnit: 'strip', unitBasis: 'authoritative_metadata', ambiguous: false, unselectableExcluded: 0,
      candidates: [{ productId: ids.product, identity: { ...identityExample, saleUnit: 'strip' } }] }, 'a single candidate under authoritative metadata');
    accept('MappingCandidates', { ...candidatesExample, candidates: [], ambiguous: false, currentProductId: ids.product, needStatus: 'covered' }, 'no eligible candidate');
    reject('MappingCandidates', { ...candidatesExample, selectionRequired: false }, 'an automatic selection');
    reject('MappingCandidates', { ...candidatesExample, selectedProductId: ids.product }, 'a candidate marked as chosen');
    reject('MappingCandidates', { ...candidatesExample, unitBasis: 'converted' }, 'an undocumented unit basis');
    reject('MappingCandidates', { ...candidatesExample, candidates: Array.from({ length: 21 }, () => candidatesExample.candidates[0]) }, 'more than the candidate bound');
    reject('MappingCandidates', { ...candidatesExample, unselectableExcluded: -1 }, 'a negative exclusion count');
    reject('MappingCandidates', { ...candidatesExample, unselectableExcluded: 22 }, 'more exclusions than the fetched window');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ ...candidatesExample.candidates[0], unitPrice: '12.35' }] }, 'a leaked price');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ productId: ids.product, identity: { ...identityExample, supplierId: ids.supplier } }] }, 'a leaked supplier');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ productId: ids.product, identity: { ...identityExample, manufacturer: '' } }] }, 'an incomplete identity');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ productId: ids.product, identity: { ...identityExample, saleUnit: ' box' } }] }, 'a sale unit with surrounding whitespace');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ productId: ids.product, identity: { ...identityExample, packSize: { value: '20.0', unit: 'tablet' } } }] }, 'a non canonical pack size');
    reject('MappingCandidates', { ...candidatesExample, candidates: [{ productId: ids.product, identity: { ...identityExample, packSize: { value: 20, unit: 'tablet' } } }] }, 'a numeric pack size');
    reject('MappingCandidates', { ...candidatesExample, organisationId: ids.organisation }, 'a leaked tenant identifier');
  });

  test('mapping result records the provenanced explicit decision', () => {
    accept('MappingResult', mappingResultExample, 'a newly recorded decision');
    accept('MappingResult', { ...mappingResultExample, needVersion: 1, repeated: true }, 'an idempotent repeat');
    accept('MappingResult', { ...mappingResultExample, unitBasis: 'authoritative_metadata' }, 'a decision carried by authoritative metadata');
    reject('MappingResult', { ...mappingResultExample, mapStatus: 'review' }, 'an unverified mapping');
    reject('MappingResult', { ...mappingResultExample, unitBasis: 'inferred' }, 'an inferred unit');
    reject('MappingResult', { ...mappingResultExample, decisionId: null }, 'a decision without provenance');
    reject('MappingResult', { ...mappingResultExample, decidedBy: ids.membership }, 'a leaked membership identity');
    reject('MappingResult', { ...mappingResultExample, unit: '' }, 'an empty unit');
    reject('MappingResult', { ...mappingResultExample, repeated: 'false' }, 'a string repeat flag');
    reject('MappingResult', { ...mappingResultExample, needVersion: 0 }, 'a non positive need version');
  });

  test('documented enumerations match the immutable migration constraints', () => {
    const roles = checkedValues('0002_finite_quantities_and_roles.sql', /CHECK \(role IN \(([^)]*)\)\)/);
    const kinds = checkedValues('0001_identity_and_tenant_isolation.sql', /kind text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/);
    const needStatus = checkedValues('0001_identity_and_tenant_isolation.sql', /DEFAULT 'open' CHECK \(status IN \(([^)]*)\)\)/);
    const orderState = checkedValues('0007_transactional_procurement.sql', /state text NOT NULL CHECK\(state IN \(([^)]*)\)\)/);
    const properties = (name: string) => component(name).properties as Record<string, Schema>;
    assert.deepEqual(properties('TenantContext').role!.enum, roles);
    assert.deepEqual(properties('TenantContext').organisationKind!.enum, kinds);
    assert.deepEqual(properties('NeedView').status!.enum, needStatus);
    assert.deepEqual(properties('OrderDetail').state!.enum, orderState);
    const itemProperties = (name: string) => ((properties(name).items as Schema).items as Schema).properties as Record<string, Schema>;
    assert.deepEqual(itemProperties('NeedPage').status!.enum, needStatus);
    assert.deepEqual(itemProperties('OrderPage').state!.enum, orderState);
    assert.deepEqual(properties('MappingCandidates').needStatus!.enum, needStatus);
    assert.equal(properties('Quote').currency!.const, 'EGP');
    assert.match(readFileSync(new URL('../../db/migrations/0007_transactional_procurement.sql', import.meta.url), 'utf8'),
      /currency text NOT NULL CHECK\(currency='EGP'\)/);
  });
});
