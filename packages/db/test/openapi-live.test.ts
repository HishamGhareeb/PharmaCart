import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { isUtcInstant } from '../../contracts/src/submission.ts';
import { FakeSupplier } from '../../supplier/src/fake.ts';
import { IntentWorker } from '../src/orders.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { ids, resetDatabase, sql } from './support.ts';

/*
 * LIVE EVIDENCE. Every payload validated below was produced by buildTenantApi over a real
 * pharmacart_test database and a real authorization-code token from the local OIDC provider. Nothing here
 * is hand written: the hand written illustrations live in packages/contracts/test/openapi-responses.test.ts
 * and are explicitly marked there as examples, not captured responses. This file is the missing half of
 * that pair — it decides whether the generated document tells the truth about the running API.
 *
 * It validates documentation conformance only and advances no acceptance criterion. The coordinator runs
 * it serially with the other database suites (npm run test:integration).
 */

type Schema = Record<string, unknown>;
type Document = { components: { schemas: Record<string, Schema> } };

const document = JSON.parse(readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8')) as Document;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// allowUnionTypes is required because OpenAPI 3.1 states a nullable field as a JSON Schema type array.
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uuid: (value: string) => UUID.test(value), 'date-time': isUtcInstant },
});

function schema(name: string): Schema {
  const found = document.components.schemas[name];
  assert.ok(found, `components.schemas.${name} is missing from the generated document`);
  return found;
}

function nested(root: Schema, path: readonly string[]): Schema {
  let current = root;
  for (const key of path) {
    const next = current[key] as Schema | undefined;
    assert.ok(next, `the generated document has no ${path.join('.')}`);
    current = next;
  }
  return current;
}

/** Validates a response the server actually produced against the contract the document publishes. */
function conforms(name: string, payload: unknown, because: string): void {
  const validator = ajv.compile(schema(name));
  assert.equal(validator(payload), true, `live ${because} violates ${name}: ${ajv.errorsText(validator.errors)}\n${JSON.stringify(payload)}`);
}

test('live contracts: generated success schemas match real authenticated PostgreSQL responses', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const directory = await mkdtemp(join(process.cwd(), 'tmp-openapi-live-'));
  const supplier = new FakeSupplier(join(directory, 'ledger.json'), 'timeout_after_accept');
  const app = buildTenantApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement();
    await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status)
      VALUES ('${ids.installation}','${ids.a}','${ids.branchA}','synthetic:connector:a','active');
      INSERT INTO inventory_target(installation_id,organisation_id,branch_id,source_code,product_ref,unit,target_quantity)
      VALUES('${ids.installation}','${ids.a}','${ids.branchA}','00017','SYN-INVENTORY-PACK','box',10)`);
    const { access_token: token } = await identity.token();
    const headers = { authorization: `Bearer ${token}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };

    // The schemas validated here must come from the document this very server serves.
    const served = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(served.statusCode, 200);
    assert.deepEqual(served.json(), document);

    const context = await app.inject({ method: 'GET', url: '/v1/context', headers });
    assert.equal(context.statusCode, 200, context.body);
    conforms('TenantContext', context.json(), 'context response');
    assert.deepEqual(context.json(), {
      principalKind: 'member', userSubject: 'synthetic:user:a', membershipId: ids.memberA,
      organisationId: ids.a, organisationKind: 'pharmacy', branchId: ids.branchA,
      allowedBranchIds: [ids.branchA], role: 'pharmacy_owner', membershipVersion: 1,
    });

    const need = await app.inject({ method: 'GET', url: `/v1/needs/${ids.needA}`, headers });
    assert.equal(need.statusCode, 200, need.body);
    conforms('NeedView', need.json(), 'open need response');
    assert.deepEqual(need.json(), { id: ids.needA, productRef: 'SYN-A', quantity: '2', status: 'open', version: 1 });

    const connector = await identity.token('synthetic:connector:a');
    const ingest = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/inventory',
      headers: { authorization: `Bearer ${connector.access_token}` }, payload: payload as object });
    const partition = { kind: 'partition', eventId: 'live-event-1', snapshotId: 'live-snap-1', sequence: 1,
      partitionId: 'p1', rows: [{ sourceCode: '00017', quantity: '8', unit: 'box' }] };
    const fresh = await ingest(partition);
    assert.equal(fresh.statusCode, 202, fresh.body);
    conforms('InventoryAcceptance', fresh.json(), 'first acceptance of a snapshot partition');
    assert.equal(fresh.json().eventId, 'live-event-1');
    assert.equal(fresh.json().duplicate, false);
    const replayed = await ingest(partition);
    assert.equal(replayed.statusCode, 202, replayed.body);
    conforms('InventoryAcceptance', replayed.json(), 'replayed acceptance of the same event');
    assert.equal(replayed.json().duplicate, true);
    assert.equal(replayed.json().projectionRevision, fresh.json().projectionRevision);
    const completed = await ingest({ kind: 'complete', eventId: 'live-event-2', snapshotId: 'live-snap-1', sequence: 1, expectedPartitionIds: ['p1'] });
    assert.equal(completed.statusCode, 202, completed.body);
    conforms('InventoryAcceptance', completed.json(), 'acceptance of a completed snapshot');
    assert.equal(completed.json().duplicate, false);
    assert(completed.json().projectionRevision > fresh.json().projectionRevision, 'completing a snapshot publishes a new projection revision');

    // A fractional quantity below the need is quoted so that the settled remainder, the supplier split and
    // the receipt sums all carry different numeric scales.
    const created = await app.inject({ method: 'POST', url: '/v1/quotes', headers,
      payload: { branchId: ids.branchA, lines: [{ needId: ids.needA, needVersion: 1, quantity: '1.5', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } } });
    assert.equal(created.statusCode, 201, created.body);
    conforms('Quote', created.json(), 'created quote');
    const quote = created.json();
    assert.equal(quote.version, 1);
    assert.equal(quote.status, 'quoted');
    assert.equal(quote.bindingStatus, 'binding');
    assert.equal(quote.currency, 'EGP');
    assert.equal(quote.pricingRuleVersion, 'synthetic-cash-tax-exempt-v1');
    assert.deepEqual(quote.unmetLines, []);
    // 12.35 EGP a box for 1.5 boxes, rounded to two decimals by the database and then canonicalised.
    assert.equal(quote.total, '18.53');
    assert.equal(quote.total, (await sql(`SELECT total::text FROM quote WHERE id='${quote.id}'`)).trim());
    assert.equal(quote.lines.length, 1);
    assert.deepEqual(
      { gross: quote.lines[0].gross, discount: quote.lines[0].discount, tax: quote.lines[0].tax, fees: quote.lines[0].fees, net: quote.lines[0].net },
      { gross: '18.53', discount: '0', tax: '0', fees: '0', net: '18.53' },
    );
    assert.equal(quote.lines[0].quantity, '1.5');
    assert.equal(quote.lines[0].identity.saleUnit, 'box');
    assert(isUtcInstant(quote.expiresAt), quote.expiresAt);

    const approve = (key: string) => app.inject({ method: 'POST', url: `/v1/quotes/${quote.id}/approve`,
      headers: { ...headers, 'idempotency-key': key }, payload: { quoteVersion: 1 } });
    const approved = await approve('live-approval-a');
    assert.equal(approved.statusCode, 202, approved.body);
    conforms('ApprovalResult', approved.json(), 'first approval');
    assert.equal(approved.json().status, 'queued');
    assert.equal(approved.json().quoteId, quote.id);
    assert.equal(approved.json().quoteVersion, 1);
    assert.equal(approved.json().orderIntentIds.length, 1);
    const replayedApproval = await approve('live-approval-a');
    assert.equal(replayedApproval.statusCode, 202, replayedApproval.body);
    conforms('ApprovalResult', replayedApproval.json(), 'replayed approval');
    assert.deepEqual(replayedApproval.json(), approved.json());
    const alreadyApproved = await approve('live-approval-b');
    assert.equal(alreadyApproved.statusCode, 200, alreadyApproved.body);
    conforms('ApprovalResult', alreadyApproved.json(), 'already approved quote under a new key');
    assert.deepEqual(alreadyApproved.json(), approved.json());
    const intentId = approved.json().orderIntentIds[0] as string;

    // Approving part of a need leaves the remainder open at the scale of the subtraction.
    const remainder = await app.inject({ method: 'GET', url: `/v1/needs/${ids.needA}`, headers });
    assert.equal(remainder.statusCode, 200, remainder.body);
    conforms('NeedView', remainder.json(), 'partially covered need response');
    assert.deepEqual(remainder.json(), { id: ids.needA, productRef: 'SYN-A', quantity: '0.5', status: 'open', version: 2 });

    const order = async (because: string) => {
      const response = await app.inject({ method: 'GET', url: `/v1/orders/${intentId}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      conforms('OrderDetail', response.json(), because);
      return response.json();
    };

    const queued = await order('queued order response');
    assert.equal(queued.state, 'queued');
    assert.equal(queued.externalOrderId, null);
    assert.equal(queued.uncertainty, null);
    // Lines are materialised when the worker claims the intent, so a queued order legitimately has none.
    assert.deepEqual(queued.lines, []);
    assert.equal(queued.externalClientRef, `pc-syn-${intentId}`);

    const worker = new IntentWorker(pool, { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA }, supplier);
    await worker.enableSyntheticDispatch();
    assert.equal((await worker.run(intentId)).state, 'outcome_unknown');
    const unknown = await order('order response with an unknown outcome');
    assert.equal(unknown.state, 'outcome_unknown');
    assert.equal(unknown.externalOrderId, null);
    assert.deepEqual(unknown.uncertainty, { safeToRetry: false, nextAction: 'reconciliation_required' });
    assert.equal(unknown.lines.length, 1);
    assert.deepEqual(
      { ordered: unknown.lines[0].ordered, accepted: unknown.lines[0].accepted, rejected: unknown.lines[0].rejected, shipped: unknown.lines[0].shipped, received: unknown.lines[0].received },
      { ordered: '1.5', accepted: '0', rejected: '0', shipped: '0', received: '0' },
    );

    assert.equal((await worker.run(intentId)).state, 'acknowledged');
    const acknowledged = await order('acknowledged order response');
    assert.equal(acknowledged.state, 'acknowledged');
    assert.equal(acknowledged.uncertainty, null);
    assert.match(acknowledged.externalOrderId, /^syn-/);
    assert.deepEqual(
      { ordered: acknowledged.lines[0].ordered, accepted: acknowledged.lines[0].accepted, rejected: acknowledged.lines[0].rejected, shipped: acknowledged.lines[0].shipped, received: acknowledged.lines[0].received },
      { ordered: '1.5', accepted: '0.5', rejected: '1', shipped: '0.5', received: '0' },
    );
    assert.equal(acknowledged.lines[0].productIdentity.saleUnit, 'box');
    const lineId = acknowledged.lines[0].id as string;

    const receipt = (reference: string, quantity: string) => app.inject({ method: 'POST', url: `/v1/orders/${intentId}/receipts`,
      headers, payload: { reference, lines: [{ lineId, quantity }] } });
    const firstReceipt = await receipt('live-receipt-a', '0.25');
    assert.equal(firstReceipt.statusCode, 200, firstReceipt.body);
    conforms('ReceiptAcknowledgement', firstReceipt.json(), 'first receipt');
    const repeatedReceipt = await receipt('live-receipt-a', '0.25');
    assert.equal(repeatedReceipt.statusCode, 200, repeatedReceipt.body);
    conforms('ReceiptAcknowledgement', repeatedReceipt.json(), 'repeated receipt');
    assert.deepEqual(repeatedReceipt.json(), firstReceipt.json());
    assert.equal((await sql('SELECT count(*) FROM receipt')).trim(), '1');
    const secondReceipt = await receipt('live-receipt-b', '0.25');
    assert.equal(secondReceipt.statusCode, 200, secondReceipt.body);
    conforms('ReceiptAcknowledgement', secondReceipt.json(), 'second receipt');
    assert.notEqual(secondReceipt.json().id, firstReceipt.json().id);

    const received = await order('received order response');
    // Numeric addition keeps the widest scale of its operands, so two receipts of 0.25 read back as '0.50'
    // against a shipped quantity of '0.5'. A canonical decimal contract would wrongly refuse this response.
    assert.equal(received.lines[0].received, '0.50');
    assert.equal(received.lines[0].shipped, '0.5');
    const storedPattern = new RegExp(nested(schema('OrderDetail'), ['properties', 'lines', 'items', 'properties', 'received']).pattern as string);
    const moneyPattern = new RegExp(nested(schema('Quote'), ['properties', 'total']).pattern as string);
    assert.equal(storedPattern.test('0.50'), true, 'stored quantities must accept a preserved scale');
    assert.equal(moneyPattern.test('0.50'), false, 'canonical amounts must refuse a trailing zero');
    assert.equal(moneyPattern.test(received.lines[0].shipped), true);
    assert.equal(moneyPattern.test(quote.total), true);

    // Live refusals: the redacted envelope is the only body the API returns for a failure.
    const exceeded = await receipt('live-receipt-c', '0.5');
    assert.equal(exceeded.statusCode, 409, exceeded.body);
    conforms('ErrorEnvelope', exceeded.json(), '409 receipt refusal');
    assert.equal(exceeded.json().error.code, 'RECEIPT_EXCEEDS_SHIPPED');
    assert.equal(exceeded.json().error.correlationId, exceeded.headers['x-correlation-id']);
    const missing = await app.inject({ method: 'GET', url: '/v1/needs/ffffffff-ffff-4fff-8fff-ffffffffffff', headers });
    assert.equal(missing.statusCode, 404);
    conforms('ErrorEnvelope', missing.json(), '404 refusal');
    const foreign = await app.inject({ method: 'GET', url: `/v1/needs/${ids.needB}`, headers: { ...headers, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB } });
    assert.equal(foreign.statusCode, 403);
    conforms('ErrorEnvelope', foreign.json(), '403 refusal');
    const anonymous = await app.inject({ method: 'GET', url: '/v1/context' });
    assert.equal(anonymous.statusCode, 401);
    conforms('ErrorEnvelope', anonymous.json(), '401 refusal');
  } finally {
    await app.close(); await pool.end(); await identity.close();
    await rm(directory, { recursive: true, force: true });
  }
});
