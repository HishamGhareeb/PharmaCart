import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { registerListRoutes } from '../src/list-routes.ts';
import { registerMappingRoutes } from '../src/mapping-routes.ts';
import type { TokenVerifier } from '../src/request-auth.ts';
import { buildTenantApi } from '../src/tenant-api.ts';
import { MAPPING_IDS, REJECTING_VERIFIER, SELECTION } from './mapping-fixture.ts';

/*
 * Registration evidence for the tenant API. No database and no identity provider: a pool that counts
 * connection attempts stands in for PostgreSQL, and every case here must be decided before one is taken.
 */

type Document = { paths: Record<string, Record<string, { operationId: string }>> };
const document = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8')) as Document;

function countingPool(): { pool: Pool; connections: () => number } {
  let attempts = 0;
  const pool = {
    connect() {
      attempts += 1;
      return Promise.reject(new Error('registration tests never reach the database'));
    },
  } as unknown as Pool;
  return { pool, connections: () => attempts };
}

const ACCEPTING_VERIFIER: TokenVerifier = {
  verifyAccessToken: () => Promise.resolve({ subject: 'synthetic:user:a' } as Awaited<ReturnType<TokenVerifier['verifyAccessToken']>>),
};

/**
 * Reads Fastify's printed route tree back into "METHOD /path" entries. HEAD is Fastify's automatic
 * companion to GET and is not a separately documented operation.
 */
function registeredRoutes(tree: string): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split('\n')) {
    const marker = line.indexOf('── ');
    if (marker < 0) continue;
    const depth = (marker - 1) / 4;
    assert(Number.isInteger(depth), `unexpected route tree line: ${line}`);
    const match = /^(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.slice(marker + 3));
    assert(match, `unexpected route tree line: ${line}`);
    stack.length = depth;
    stack.push(match[1]!);
    for (const method of (match[2] ?? '').split(', ').filter((value) => value !== '' && value !== 'HEAD')) {
      routes.push(`${method} ${stack.join('')}`);
    }
  }
  return routes.sort();
}

test('buildTenantApi serves exactly the documented operations, including the list and mapping routes', async () => {
  const { pool, connections } = countingPool();
  const app = buildTenantApi(pool, REJECTING_VERIFIER);
  try {
    await app.ready();
    const documented = Object.entries(document.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replaceAll('{id}', ':id')}`))
      .sort();
    const registered = registeredRoutes(app.printRoutes({ commonPrefix: false }));
    for (const route of ['GET /v1/needs', 'GET /v1/orders', 'GET /v1/needs/:id/mapping-candidates', 'POST /v1/needs/:id/mapping']) {
      assert(documented.includes(route), `${route} is not documented`);
      const [method, url] = route.split(' ') as ['GET' | 'POST', string];
      assert.equal(app.hasRoute({ method, url }), true, `${route} is not registered`);
    }
    assert.deepEqual(registered, documented, 'every served operation is documented and every documented operation is served');
    assert.equal(connections(), 0);
  } finally {
    await app.close();
  }
});

test('the list and mapping modules are registered once, so registering them again is refused', async () => {
  const { pool } = countingPool();
  const app = buildTenantApi(pool, REJECTING_VERIFIER);
  try {
    // A caller that still layers the modules on top of buildTenantApi would now fail loudly, not twice-serve.
    assert.throws(() => { registerListRoutes(app, pool, REJECTING_VERIFIER); }, (error: unknown) => (error as { code?: string }).code === 'FST_ERR_DUPLICATED_ROUTE');
    assert.throws(() => { registerMappingRoutes(app, pool, REJECTING_VERIFIER); }, (error: unknown) => (error as { code?: string }).code === 'FST_ERR_DUPLICATED_ROUTE');
  } finally {
    await app.close();
  }
});

test('the registered routes authenticate, then validate tenant selectors, before any connection is taken', async () => {
  const requests = [
    { method: 'GET' as const, url: '/v1/needs' },
    { method: 'GET' as const, url: '/v1/orders' },
    { method: 'GET' as const, url: `/v1/needs/${MAPPING_IDS.need}/mapping-candidates` },
    { method: 'POST' as const, url: `/v1/needs/${MAPPING_IDS.need}/mapping`, payload: SELECTION },
  ];

  const anonymous = countingPool();
  const guarded = buildTenantApi(anonymous.pool, REJECTING_VERIFIER);
  try {
    for (const request of requests) {
      const response = await guarded.inject({ ...request, headers: { 'x-organisation-id': MAPPING_IDS.organisation, 'x-branch-id': MAPPING_IDS.branch } });
      assert.equal(response.statusCode, 401, `${request.url}: ${response.body}`);
      assert.equal(response.json().error.code, 'UNAUTHENTICATED');
    }
    assert.equal(anonymous.connections(), 0);
  } finally {
    await guarded.close();
  }

  const authenticated = countingPool();
  const scoped = buildTenantApi(authenticated.pool, ACCEPTING_VERIFIER);
  try {
    for (const request of requests) {
      for (const headers of [
        { authorization: 'Bearer synthetic' },
        { authorization: 'Bearer synthetic', 'x-organisation-id': MAPPING_IDS.organisation, 'x-branch-id': 'not-a-uuid' },
      ]) {
        const response = await scoped.inject({ ...request, headers });
        assert.equal(response.statusCode, 400, `${request.url}: ${response.body}`);
        assert.equal(response.json().error.code, 'INVALID_REQUEST');
        assert.doesNotMatch(response.body, /not-a-uuid/);
      }
    }
    assert.equal(authenticated.connections(), 0, 'a malformed selector must be refused before a connection is taken');

    // With valid selectors the request does reach the pool, and a pool failure stays redacted.
    const response = await scoped.inject({ ...requests[0]!, headers: { authorization: 'Bearer synthetic', 'x-organisation-id': MAPPING_IDS.organisation, 'x-branch-id': MAPPING_IDS.branch } });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(response.body, /registration tests never reach/);
    assert.equal(authenticated.connections(), 1);
  } finally {
    await scoped.close();
  }
});
