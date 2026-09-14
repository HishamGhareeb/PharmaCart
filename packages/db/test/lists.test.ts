import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { buildTenantApi, type TokenVerifier } from '../../../apps/api/src/tenant-api.ts';
import { registerListRoutes } from '../../../apps/api/src/list-routes.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { ListError, listNeeds, listOrders, type ListPrincipal } from '../src/lists.ts';
import { ids, resetDatabase, sql } from './support.ts';
import { seedProcurement } from './procurement-fixture.ts';

// Synthetic rows added for the list surface only. The shared fixture ids are untouched.
const extra = {
  unmapped: '4000000a-0000-4000-8000-000000000001',
  underReview: '4000000b-0000-4000-8000-000000000001',
  closed: '4000000c-0000-4000-8000-000000000001',
  reviewMap: '7000000b-0000-4000-8000-000000000001',
  verifiedProduct: '60000000-0000-4000-8000-000000000001',
};

// PostgreSQL orders uuid by its 16 bytes, which equals hex order for canonical lowercase text.
const compareUuid = (left: string, right: string): number => {
  const a = left.replaceAll('-', '');
  const b = right.replaceAll('-', '');
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The registration hook the coordinator applies after review. This module never edits
 * apps/api/src/tenant-api.ts; the single added line is reproduced here so the integration run
 * exercises exactly what integration will do.
 */
function buildListApi(pool: Pool, verifier: TokenVerifier) {
  const app = buildTenantApi(pool, verifier);
  registerListRoutes(app, pool, verifier);
  return app;
}

async function seedListFixtures() {
  await sql(`
    UPDATE need SET requested_quantity=2.500 WHERE id='${ids.needA}';
    INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES
    ('${extra.reviewMap}','${ids.a}','${ids.branchA}','${extra.verifiedProduct}','review',1);
    INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity,status,source_map_id) VALUES
    ('${extra.unmapped}','${ids.a}','${ids.branchA}','SYN-A-UNMAPPED',7,'open',NULL),
    ('${extra.underReview}','${ids.a}','${ids.branchA}','SYN-A-REVIEW',1,'open','${extra.reviewMap}'),
    ('${extra.closed}','${ids.a}','${ids.branchA}','SYN-A-CLOSED',4,'closed',NULL);`);
}

const branchANeedIds = [ids.needA, extra.unmapped, extra.underReview, extra.closed].sort(compareUuid);

type NeedItem = {
  id: string; productRef: string; quantity: string; outstandingQuantity: string | null;
  status: string; version: number; mappingStatus: string; productId: string | null; saleUnit: string | null;
};
type NeedPage = { items: NeedItem[]; nextCursor: string | null };

test('AC-001/AC-004 evidence: tenant-scoped need listing over real OIDC and PostgreSQL', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = buildListApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement();
    await seedListFixtures();
    const { access_token: tokenA } = await identity.token('synthetic:user:a');
    const { access_token: tokenB } = await identity.token('synthetic:user:b');
    const headersA = { authorization: `Bearer ${tokenA}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const headersB = { authorization: `Bearer ${tokenB}`, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB };

    // 1. The branch sees exactly its own needs, in deterministic uuid order, with no cross-tenant count.
    const all = await app.inject({ url: '/v1/needs?limit=100', headers: headersA });
    assert.equal(all.statusCode, 200, all.body);
    const page = all.json() as NeedPage;
    assert.deepEqual(page.items.map((item) => item.id), branchANeedIds);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
    assert.doesNotMatch(all.body, /SYN-B-PRIVATE|"total"|"count"/);

    // 2. Verified mapping discloses the product identity and the authoritative sale unit; nothing else does.
    const byId = new Map(page.items.map((item) => [item.id, item]));
    const mapped = byId.get(ids.needA);
    assert(mapped);
    assert.equal(mapped.mappingStatus, 'verified');
    assert.equal(mapped.productId, extra.verifiedProduct);
    assert.equal(mapped.saleUnit, 'box');
    assert.equal(mapped.quantity, '2.500', 'the exact numeric scale must survive unchanged');
    assert.equal(mapped.outstandingQuantity, '2.500');

    const unmapped = byId.get(extra.unmapped);
    assert(unmapped);
    assert.deepEqual([unmapped.mappingStatus, unmapped.productId, unmapped.saleUnit], ['unmapped', null, null]);

    const review = byId.get(extra.underReview);
    assert(review);
    assert.deepEqual([review.mappingStatus, review.productId, review.saleUnit], ['unverified', null, null],
      'a mapping under review must not disclose a product identity or invent a unit');

    const closed = byId.get(extra.closed);
    assert(closed);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.quantity, '4');
    assert.equal(closed.outstandingQuantity, '0', 'a closed need has no outstanding demand');

    // 3. The list grants no more than the individual resource route.
    const single = await app.inject({ url: `/v1/needs/${ids.needA}`, headers: headersA });
    assert.equal(single.statusCode, 200);
    const singleBody = single.json() as Record<string, unknown>;
    for (const key of Object.keys(singleBody)) assert.equal(mapped[key as keyof NeedItem], singleBody[key], `field ${key} diverges from the individual route`);
    assert.deepEqual(
      Object.keys(mapped).filter((key) => !(key in singleBody)).sort(),
      ['mappingStatus', 'outstandingQuantity', 'productId', 'saleUnit'],
      'only the documented mapping additions may be new',
    );

    // 4. The allowlisted status filter is applied and is never a free identifier.
    const open = await app.inject({ url: '/v1/needs?status=open&limit=100', headers: headersA });
    assert.equal(open.statusCode, 200, open.body);
    assert.deepEqual((open.json() as NeedPage).items.map((item) => item.id), [ids.needA, extra.unmapped, extra.underReview].sort(compareUuid));
    const none = await app.inject({ url: '/v1/needs?status=covered', headers: headersA });
    assert.deepEqual(none.json(), { items: [], nextCursor: null });

    for (const query of [
      "status=open'%20OR%201%3D1--",
      'status=open%3B%20DROP%20TABLE%20need',
      'status=n.organisation_id',
      'limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'limit=1.5',
      'order=id%20DESC', 'branchId=' + ids.branchB, 'limit=1&limit=2',
    ]) {
      const refused = await app.inject({ url: `/v1/needs?${query}`, headers: headersA });
      assert.equal(refused.statusCode, 400, `${query} -> ${refused.body}`);
      assert.equal(refused.json().error.code, 'INVALID_REQUEST');
      assert.doesNotMatch(refused.body, /DROP|organisation_id|SYN-|1=1/i);
    }
    assert.equal((await sql('SELECT count(*) FROM need')).trim(), '5', 'no refused filter may have executed');

    // 5. Keyset pagination walks every row exactly once and is repeatable.
    const walked: string[] = [];
    let url: string | null = '/v1/needs?limit=1';
    for (let step = 0; url !== null; step += 1) {
      assert(step < 10, 'pagination must terminate');
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ url, headers: headersA });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as NeedPage;
      assert(body.items.length <= 1);
      walked.push(...body.items.map((item) => item.id));
      url = body.nextCursor === null ? null : `/v1/needs?limit=1&cursor=${body.nextCursor}`;
    }
    assert.deepEqual(walked, branchANeedIds);
    assert.equal(new Set(walked).size, walked.length);

    const first = await app.inject({ url: '/v1/needs?limit=2', headers: headersA });
    const cursor = (first.json() as NeedPage).nextCursor;
    assert(cursor);
    const replayOne = await app.inject({ url: `/v1/needs?limit=2&cursor=${cursor}`, headers: headersA });
    const replayTwo = await app.inject({ url: `/v1/needs?limit=2&cursor=${cursor}`, headers: headersA });
    assert.equal(replayOne.body, replayTwo.body, 'a repeated cursor over unchanged data must return the identical page');
    assert.deepEqual((replayOne.json() as NeedPage).items.map((item) => item.id), branchANeedIds.slice(2));

    // 6. A cursor cannot cross a tenant, a branch, a resource or a filter.
    for (const [target, headers] of [['foreign tenant', headersB], ['own tenant', headersA]] as const) {
      const crossFilter: Awaited<ReturnType<typeof app.inject>> = await app.inject({ url: `/v1/needs?status=open&cursor=${cursor}`, headers });
      assert.equal(crossFilter.statusCode, 400, `${target}: ${crossFilter.body}`);
      assert.equal(crossFilter.json().error.code, 'INVALID_CURSOR');
    }
    const crossTenant = await app.inject({ url: `/v1/needs?limit=2&cursor=${cursor}`, headers: headersB });
    const malformed = await app.inject({ url: '/v1/needs?limit=2&cursor=Zm9yZ2VkLWN1cnNvcg', headers: headersB });
    assert.equal(crossTenant.statusCode, 400, crossTenant.body);
    assert.equal(crossTenant.json().error.code, 'INVALID_CURSOR');
    assert.equal(crossTenant.json().error.message, malformed.json().error.message, 'a foreign cursor must be no oracle');
    assert.equal(crossTenant.json().error.code, malformed.json().error.code);
    assert.doesNotMatch(crossTenant.body, /SYN-A|items|nextCursor/);
    const crossResource = await app.inject({ url: `/v1/orders?limit=2&cursor=${cursor}`, headers: headersA });
    assert.equal(crossResource.statusCode, 400, crossResource.body);
    assert.equal(crossResource.json().error.code, 'INVALID_CURSOR');

    // 7. The other tenant sees only its own need and never organisation A's.
    const foreign = await app.inject({ url: '/v1/needs?limit=100', headers: headersB });
    assert.equal(foreign.statusCode, 200, foreign.body);
    assert.deepEqual((foreign.json() as NeedPage).items.map((item) => item.id), [ids.needB]);
    assert.doesNotMatch(foreign.body, /SYN-A/);
    assert.equal((await app.inject({ url: '/v1/needs', headers: { ...headersA, 'x-branch-id': ids.branchB } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/needs', headers: { ...headersB, 'x-organisation-id': ids.a } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/needs' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/v1/orders' })).statusCode, 401);

    // 8. Revoked membership loses the list exactly as it loses the individual route.
    await sql(`UPDATE membership SET status='revoked' WHERE id='${ids.memberA}'`);
    assert.equal((await app.inject({ url: '/v1/needs', headers: headersA })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/orders', headers: headersA })).statusCode, 403);
    await sql(`UPDATE membership SET status='active' WHERE id='${ids.memberA}'`);
    assert.equal((await app.inject({ url: '/v1/needs', headers: headersA })).statusCode, 200);
  } finally {
    await app.close(); await pool.end(); await identity.close();
  }
});

test('row level security alone bounds the list query: no tenant context returns no rows', async () => {
  const pool = await resetDatabase();
  try {
    await seedProcurement();
    await seedListFixtures();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE pharmacart_runtime');
      // Deliberately no set_config('app.organisation_id'/'app.branch_id'): the SELECT carries no tenant
      // predicate of its own, so the policy is the only thing standing between it and every row.
      const scopeA: ListPrincipal = { organisationId: ids.a, branchId: ids.branchA, organisationKind: 'pharmacy' };
      const needs = await listNeeds(client, scopeA, { limit: 100, status: null, after: null });
      const orders = await listOrders(client, scopeA, { limit: 100, status: null, after: null });
      assert.deepEqual(needs, { items: [], nextCursor: null });
      assert.deepEqual(orders, { items: [], nextCursor: null });

      // With the policy satisfied for organisation B the same statement returns B's row and nothing of A's.
      await client.query(`SELECT set_config('app.organisation_id',$1,true), set_config('app.branch_id',$2,true)`, [ids.b, ids.branchB]);
      const scopeB: ListPrincipal = { organisationId: ids.b, branchId: ids.branchB, organisationKind: 'pharmacy' };
      const scoped = await listNeeds(client, scopeB, { limit: 100, status: null, after: null });
      assert.deepEqual(scoped.items.map((item) => item.id), [ids.needB]);

      // The pharmacy-side gate is independent of the policy: a supplier principal is refused outright,
      // even here where the GUCs would have let the statement run.
      const supplier: ListPrincipal = { ...scopeB, organisationKind: 'supplier' };
      await assert.rejects(() => listNeeds(client, supplier, { limit: 1, status: null, after: null }),
        (error: unknown) => error instanceof ListError && error.status === 403);
      await assert.rejects(() => listOrders(client, supplier, { limit: 1, status: null, after: null }),
        (error: unknown) => error instanceof ListError && error.status === 403);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test('order listing summarises the caller\'s own intents without other-party detail', async () => {
  const pool = await resetDatabase();
  const identity = await localIdentity();
  const app = buildListApi(pool, createAccessTokenVerifier({ issuer: identity.issuer, jwksUri: `${identity.issuer}/jwks`, audience: 'pharmacart-api' }));
  try {
    await seedProcurement();
    const { access_token: tokenA } = await identity.token('synthetic:user:a');
    const { access_token: tokenB } = await identity.token('synthetic:user:b');
    const headersA = { authorization: `Bearer ${tokenA}`, 'x-organisation-id': ids.a, 'x-branch-id': ids.branchA };
    const headersB = { authorization: `Bearer ${tokenB}`, 'x-organisation-id': ids.b, 'x-branch-id': ids.branchB };

    const empty = await app.inject({ url: '/v1/orders', headers: headersA });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), { items: [], nextCursor: null });

    const quote = await app.inject({ method: 'POST', url: '/v1/quotes', headers: headersA,
      payload: { branchId: ids.branchA, lines: [{ needId: ids.needA, needVersion: 1, quantity: '2', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } } });
    assert.equal(quote.statusCode, 201, quote.body);
    const approve = await app.inject({ method: 'POST', url: `/v1/quotes/${quote.json().id}/approve`,
      headers: { ...headersA, 'idempotency-key': 'list-orders-key' }, payload: { quoteVersion: 1 } });
    assert.equal(approve.statusCode, 202, approve.body);
    const intentId = approve.json().orderIntentIds[0] as string;

    const listed = await app.inject({ url: '/v1/orders?limit=100', headers: headersA });
    assert.equal(listed.statusCode, 200, listed.body);
    const orders = listed.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
    assert.equal(orders.items.length, 1);
    const order = orders.items[0]!;
    assert.equal(order.id, intentId);
    assert.equal(order.state, 'queued');
    assert.equal(order.uncertainty, null);
    assert.deepEqual(order.lines, { total: 0, settled: 0, awaitingReceipt: 0 }, 'a queued intent has no dispatched lines yet');
    assert.deepEqual(Object.keys(order).sort(), ['externalClientRef', 'externalOrderId', 'id', 'lines', 'state', 'uncertainty', 'version']);
    assert.doesNotMatch(listed.body, new RegExp(`${ids.supplier}|${quote.json().id}|EGP|12\\.35|24\\.7`),
      'a list entry must not disclose the counterparty, the quote or its pricing');

    // The list grants no more than the individual order route.
    const single = await app.inject({ url: `/v1/orders/${intentId}`, headers: headersA });
    assert.equal(single.statusCode, 200, single.body);
    for (const key of ['id', 'state', 'externalClientRef', 'externalOrderId', 'version', 'uncertainty']) {
      assert.deepEqual(order[key], (single.json() as Record<string, unknown>)[key], `field ${key} diverges from the individual route`);
    }

    // The allowlisted state filter is applied; the other tenant sees nothing.
    assert.deepEqual((await app.inject({ url: '/v1/orders?status=queued', headers: headersA })).json().items.length, 1);
    assert.deepEqual((await app.inject({ url: '/v1/orders?status=acknowledged', headers: headersA })).json(), { items: [], nextCursor: null });
    assert.equal((await app.inject({ url: '/v1/orders?status=open', headers: headersA })).statusCode, 400);
    const foreign = await app.inject({ url: '/v1/orders?limit=100', headers: headersB });
    assert.equal(foreign.statusCode, 200, foreign.body);
    assert.deepEqual(foreign.json(), { items: [], nextCursor: null });
    assert.doesNotMatch(foreign.body, new RegExp(intentId));
  } finally {
    await app.close(); await pool.end(); await identity.close();
  }
});
