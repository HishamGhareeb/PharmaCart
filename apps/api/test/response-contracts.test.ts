import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';

import { renderOpenapi } from '../../../packages/contracts/scripts/openapi.ts';
import { isUtcInstant } from '../../../packages/contracts/src/submission.ts';
import { buildApp } from '../src/app.ts';

/*
 * Real response evidence. Every payload asserted here was produced by a running Fastify instance through
 * inject, not hand written. buildApp only serves the two unauthenticated operations, so the tenant
 * contracts (context, needs, inventory, quotes, approve, order detail, receipt) cannot be exercised here.
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
