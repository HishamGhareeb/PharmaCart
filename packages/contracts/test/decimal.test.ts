import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isCanonicalDecimalString,
  isNonNegativeDecimalString,
  isPositiveDecimalString,
} from '../src/decimal.ts';

describe('canonical decimal strings', () => {
  test('accepts canonical integers and fractions including a negative fraction', () => {
    for (const value of ['0', '7', '-7', '12.34', '-0.5']) {
      assert.equal(isCanonicalDecimalString(value), true, value);
    }
  });

  test('rejects non-strings and noncanonical spellings', () => {
    for (const value of [12.3, '', ' 1', '1 ', '1\t', '1\n', '1\r\n', '+1', '01', '-01', '.5', '1.', '1e3', '1E3', '1.0', '1.20', '-0', '-0.0', '-0.00']) {
      assert.equal(isCanonicalDecimalString(value), false, String(value));
    }
  });

  test('enforces the default length bound before attempting validation', () => {
    assert.equal(isCanonicalDecimalString('1'.repeat(129)), false);
    assert.equal(isCanonicalDecimalString('1'.repeat(128)), true);
  });

  test('allows callers to choose a smaller positive length bound', () => {
    assert.equal(isCanonicalDecimalString('1234', { maxLength: 3 }), false);
    assert.equal(isCanonicalDecimalString('123', { maxLength: 3 }), true);
    assert.throws(() => isCanonicalDecimalString('1', { maxLength: 0 }), /maxLength/);
  });

  test('nonnegative refinement accepts zero and rejects negative values', () => {
    assert.equal(isNonNegativeDecimalString('0'), true);
    assert.equal(isNonNegativeDecimalString('0.5'), true);
    assert.equal(isNonNegativeDecimalString('-0.5'), false);
    assert.equal(isNonNegativeDecimalString('1.0'), false);
  });

  test('positive refinement rejects zero and negative values', () => {
    assert.equal(isPositiveDecimalString('0'), false);
    assert.equal(isPositiveDecimalString('0.01'), true);
    assert.equal(isPositiveDecimalString('10'), true);
    assert.equal(isPositiveDecimalString('-0.5'), false);
  });
});
