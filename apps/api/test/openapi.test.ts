import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

test('OpenAPI endpoint serves the canonical implemented health contract', async () => {
  const app = buildApp();
  try {
    const response = await app.inject('/openapi.json');
    assert.equal(response.statusCode, 200);
    const canonical = JSON.parse(await readFile(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
    assert.deepEqual(response.json(), canonical);
    assert.equal(canonical.openapi, '3.1.0');
    assert(canonical.paths['/health'].get.responses['200']);
  } finally { await app.close(); }
});
