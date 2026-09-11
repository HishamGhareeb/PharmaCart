import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { validateApprovalCommand } from '../src/approval.ts';

describe('approval command validation', () => {
  test('accepts exactly a positive safe integer quoteVersion', () => {
    assert.deepEqual(validateApprovalCommand({ quoteVersion: 4 }), {
      ok: true,
      value: { quoteVersion: 4 },
    });
  });

  test('rejects null, arrays, and primitive bodies', () => {
    for (const input of [null, [], '4', 4, true]) {
      assert.equal(validateApprovalCommand(input).ok, false, String(input));
    }
  });

  test('rejects missing and unknown properties', () => {
    assert.equal(validateApprovalCommand({}).ok, false);
    assert.equal(validateApprovalCommand({ quoteVersion: 4, organisationId: 'forged' }).ok, false);
  });

  test('rejects non-positive, fractional, and unsafe versions', () => {
    for (const quoteVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '4']) {
      assert.equal(validateApprovalCommand({ quoteVersion }).ok, false, String(quoteVersion));
    }
  });
});
