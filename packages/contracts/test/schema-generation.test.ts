import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { validateApprovalCommand } from '../src/approval.ts';
import { isCanonicalDecimalString } from '../src/decimal.ts';
import { isUtcInstant, validateOrderLookup, validateSubmitResult } from '../src/submission.ts';
import {
  readCanonicalSchemaEntries,
  renderGeneratedContractsFromEntries,
} from '../scripts/contract-codegen.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cloneEntries = () => readCanonicalSchemaEntries().map(({ name, schema }) => ({ name, schema: structuredClone(schema) }));

describe('canonical schema generation', () => {
  test('draft 2020-12 schemas are strict and generated artifacts are current', () => {
    for (const name of ['decimal', 'approval-command', 'submit-result', 'order-lookup']) {
      const schema = JSON.parse(readFileSync(`${packageRoot}/schema/${name}.schema.json`, 'utf8'));
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    }

    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-contracts.ts'],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    assert.match(output, /contracts verified/);
  });

  test('generated artifact records a deterministic SHA-256 source hash', () => {
    const generated = readFileSync(`${packageRoot}/generated/contracts.ts`, 'utf8');
    assert.match(generated, /source-sha256: [a-f0-9]{64}/);
    assert.match(generated, /export type SubmitResult/);
    assert.match(generated, /export type OrderLookup/);
  });

  test('derives object properties from schema changes instead of only refreshing the hash', () => {
    const entries = cloneEntries();
    const approval = entries.find((entry) => entry.name === 'approval-command.schema.json');
    assert.ok(approval);
    const schema = approval.schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    schema.properties.reason = { type: 'string' };
    schema.required.push('reason');

    const emitted = renderGeneratedContractsFromEntries(entries);
    assert.match(emitted, /readonly reason: string/);
  });

  test('fails closed when a schema uses an unsupported keyword', () => {
    const entries = cloneEntries();
    const approval = entries.find((entry) => entry.name === 'approval-command.schema.json');
    assert.ok(approval);
    (approval.schema as Record<string, unknown>).unevaluatedProperties = false;

    assert.throws(
      () => renderGeneratedContractsFromEntries(entries),
      /unsupported schema keyword.*unevaluatedProperties/i,
    );
  });

  test('derives discriminant changes and resolves local schema references', () => {
    const entries = cloneEntries();
    const approval = entries.find(({ name }) => name === 'approval-command.schema.json')!;
    approval.schema = { ...approval.schema, $defs: { version: { type: 'integer' } },
      properties: { quoteVersion: { $ref: '#/$defs/version' } } };
    const submit = entries.find(({ name }) => name === 'submit-result.schema.json')!;
    submit.schema.oneOf = [{ type: 'object', additionalProperties: false, required: ['kind'],
      properties: { kind: { const: 'new_outcome' } } }];
    const emitted = renderGeneratedContractsFromEntries(entries);
    assert.match(emitted, /quoteVersion: number/);
    assert.match(emitted, /kind: "new_outcome"/);
  });

  test('rejects recursive refs and open objects rather than emitting inaccurate types', () => {
    for (const properties of [
      { type: 'object', additionalProperties: true, properties: {} },
      { $ref: '#/$defs/loop', $defs: { loop: { $ref: '#/$defs/loop' } } },
    ]) {
      const entries = cloneEntries();
      const approval = entries.find(({ name }) => name === 'approval-command.schema.json')!;
      approval.schema = properties;
      assert.throws(() => renderGeneratedContractsFromEntries(entries), /unsupported open object|recursive.*ref/);
    }
  });

  test('Ajv 2020 compiles canonical schemas and agrees with runtime validators', () => {
    const ajv = new Ajv2020({ strict: true, formats: { 'date-time': isUtcInstant } });
    const validators = new Map(
      readCanonicalSchemaEntries().map(({ name, schema }) => [name, ajv.compile(schema)]),
    );
    const corpus = [
      ['decimal.schema.json', '12.34', true, isCanonicalDecimalString],
      ['decimal.schema.json', '12.340', false, isCanonicalDecimalString],
      ['approval-command.schema.json', { quoteVersion: 4 }, true, (value: unknown) => validateApprovalCommand(value).ok],
      ['approval-command.schema.json', { quoteVersion: 4, tenantId: 'forged' }, false, (value: unknown) => validateApprovalCommand(value).ok],
      ['submit-result.schema.json', { kind: 'accepted', externalOrderId: 'ERP-1' }, true, (value: unknown) => validateSubmitResult(value).ok],
      ['submit-result.schema.json', { kind: 'accepted', externalOrderId: '😀'.repeat(256) }, true, (value: unknown) => validateSubmitResult(value).ok],
      ['submit-result.schema.json', { kind: 'accepted', externalOrderId: 'ERP-1', extra: true }, false, (value: unknown) => validateSubmitResult(value).ok],
      ['order-lookup.schema.json', { kind: 'not_found', authoritativeAt: '2026-09-11T10:10:00Z', retryPermitted: true }, true, (value: unknown) => validateOrderLookup(value).ok],
      ['order-lookup.schema.json', { kind: 'not_found', authoritativeAt: '', retryPermitted: true }, false, (value: unknown) => validateOrderLookup(value).ok],
      ['order-lookup.schema.json', { kind: 'not_found', authoritativeAt: '2026-02-30T10:10:00Z', retryPermitted: true }, false, (value: unknown) => validateOrderLookup(value).ok],
      ['order-lookup.schema.json', { kind: 'not_found', authoritativeAt: '2026-09-11T13:10:00+03:00', retryPermitted: true }, false, (value: unknown) => validateOrderLookup(value).ok],
    ] as const;

    for (const [schemaName, value, expected, runtimeValidator] of corpus) {
      const schemaValidator = validators.get(schemaName);
      assert.ok(schemaValidator);
      assert.equal(schemaValidator(value), expected, `Ajv: ${schemaName} ${JSON.stringify(value)}`);
      assert.equal(runtimeValidator(value), expected, `runtime: ${schemaName} ${JSON.stringify(value)}`);
    }
  });
});

