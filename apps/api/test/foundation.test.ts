import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  register?: (app: FastifyInstance) => void,
  bodyLimit?: number,
): Promise<void> {
  const app = buildApp({ ...(register === undefined ? {} : { register }), ...(bodyLimit === undefined ? {} : { bodyLimit }) });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('GET /health reports the API as healthy and includes a generated correlation UUID', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.match(String(response.headers['x-correlation-id'] ?? ''), UUID_PATTERN);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  });
});

test('a valid client correlation UUID is retained', async () => {
  const correlationId = '6f4a508d-c8d2-48b7-90e6-9253b78c88d7';
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': correlationId },
    });

    assert.equal(response.headers['x-correlation-id'], correlationId);
  });
});

test('an invalid client correlation value is replaced and never reflected', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'attacker-controlled' },
    });

    assert.match(String(response.headers['x-correlation-id'] ?? ''), UUID_PATTERN);
    assert.notEqual(response.headers['x-correlation-id'], 'attacker-controlled');
  });
});

test('unknown routes use the stable error envelope and correlation header', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'GET', url: '/missing' });
    const correlationId = response.headers['x-correlation-id'];

    assert.equal(response.statusCode, 404);
    assert.match(String(correlationId ?? ''), UUID_PATTERN);
    assert.deepEqual(response.json(), {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        correlationId,
      },
    });
  });
});

test('malformed JSON is rejected at the request boundary without leaking parser details', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/boundary',
        headers: { 'content-type': 'application/json' },
        payload: '{"secret":"do-not-leak"',
      });
      const body = response.json();

      assert.equal(response.statusCode, 400);
      assert.equal(body.error.code, 'INVALID_JSON');
      assert.equal(body.error.message, 'The request body is not valid JSON.');
      assert.equal(body.error.correlationId, response.headers['x-correlation-id']);
      assert.doesNotMatch(response.body, /secret|stack|syntax/i);
    },
    (app) => {
      app.post('/boundary', async () => ({ accepted: true }));
    },
  );
});

test('schema validation rejects unknown command properties without echoing values', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/boundary',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'allowed', organisationId: 'forbidden-tenant-selector' },
      });

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request does not match the required contract.',
          correlationId: response.headers['x-correlation-id'],
        },
      });
      assert.doesNotMatch(response.body, /forbidden-tenant-selector/);
    },
    (app) => {
      app.post(
        '/boundary',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
          },
        },
        async () => ({ accepted: true }),
      );
    },
  );
});

test('oversized bodies are rejected with the documented 413 boundary error', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/boundary',
        headers: { 'content-type': 'application/json' },
        payload: { value: 'larger than limit' },
      });

      assert.equal(response.statusCode, 413);
      assert.equal(response.json().error.code, 'PAYLOAD_TOO_LARGE');
    },
    (app) => {
      app.post('/boundary', async () => ({ accepted: true }));
    },
    8,
  );
});

test('unsupported request media types receive a stable redacted response', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/boundary',
        headers: { 'content-type': 'application/xml' },
        payload: '<secret>do-not-leak</secret>',
      });

      assert.equal(response.statusCode, 415);
      assert.equal(response.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
      assert.doesNotMatch(response.body, /do-not-leak/);
    },
    (app) => {
      app.post('/boundary', async () => ({ accepted: true }));
    },
  );
});

test('unexpected errors are redacted behind one stable internal error', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({ method: 'GET', url: '/failure' });

      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          correlationId: response.headers['x-correlation-id'],
        },
      });
      assert.doesNotMatch(response.body, /database-password|stack/i);
    },
    (app) => {
      app.get('/failure', async () => {
        throw new Error('database-password');
      });
    },
  );
});
