import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  subtractDecimals,
} from '../src/exact-decimal.ts';

describe('exact decimal addition and subtraction', () => {
  it('adds and subtracts the way arithmetic does, not the way doubles do', () => {
    assert.equal(addDecimals('0.1', '0.2'), '0.3');
    assert.equal(subtractDecimals('0.3', '0.1'), '0.2');
    assert.equal(addDecimals('12.50', '7.5'), '20');
    assert.equal(subtractDecimals('20', '12.5'), '7.5');
  });

  it('carries across scales and signs without drifting', () => {
    assert.equal(subtractDecimals('10', '12.5'), '-2.5');
    assert.equal(addDecimals('-2.5', '2.5'), '0');
    assert.equal(subtractDecimals('1', '1'), '0');
    assert.equal(addDecimals('0.001', '0.009'), '0.01');
  });

  it('keeps precision no double could hold', () => {
    assert.equal(
      addDecimals('9007199254740992', '1'),
      '9007199254740993',
    );
    assert.equal(
      subtractDecimals('0.30000000000000004', '0.00000000000000004'),
      '0.3',
    );
  });

  it('refuses an operand it cannot read exactly', () => {
    assert.equal(addDecimals('1e3', '1'), undefined);
    assert.equal(subtractDecimals('1', '1,000'), undefined);
  });
});

describe('exact decimal comparison', () => {
  it('orders by value, not by the string it happens to be written as', () => {
    assert.equal(compareDecimals('2', '10'), -1);
    assert.equal(compareDecimals('10', '2'), 1);
    assert.equal(compareDecimals('1.9', '1.10'), 1);
    assert.equal(compareDecimals('0.5', '0.50'), 0);
    assert.equal(compareDecimals('12.5', '12.500'), 0);
  });

  it('orders negatives and zero the way arithmetic does', () => {
    assert.equal(compareDecimals('-1', '1'), -1);
    assert.equal(compareDecimals('-10', '-2'), -1);
    assert.equal(compareDecimals('0', '-0.0'), 0);
    assert.equal(compareDecimals('-0.001', '0'), -1);
  });

  it('separates values no double could tell apart', () => {
    const low = '9007199254740993';
    const high = '9007199254740994';
    assert.equal(compareDecimals(low, high), -1);
    assert.equal(compareDecimals('0.10000000000000001', '0.10000000000000002'), -1);
  });

  it('reports an unusable operand rather than sorting it arbitrarily', () => {
    assert.equal(compareDecimals('abc', '1'), undefined);
    assert.equal(compareDecimals('1', '1,000'), undefined);
    assert.equal(compareDecimals('1e3', '1'), undefined);
    assert.equal(compareDecimals('', '1'), undefined);
  });
});

describe('exact decimal multiplication', () => {
  it('produces the result arithmetic gives, not the one binary floats give', () => {
    assert.equal(multiplyDecimals('0.1', '0.2'), '0.02');
    assert.equal(multiplyDecimals('1.1', '3'), '3.3');
    assert.equal(multiplyDecimals('12.50', '4'), '50');
  });

  it('canonicalises the product, so equal totals compare equal', () => {
    assert.equal(multiplyDecimals('2.50', '2'), '5');
    assert.equal(multiplyDecimals('0.5', '0'), '0');
    assert.equal(multiplyDecimals('-2.5', '0'), '0');
  });

  it('keeps the sign and the full precision of both operands', () => {
    assert.equal(multiplyDecimals('-1.5', '2'), '-3');
    assert.equal(multiplyDecimals('-1.5', '-2'), '3');
    assert.equal(
      multiplyDecimals('123456789012345678.9', '10'),
      '1234567890123456789',
    );
  });

  it('refuses an operand it cannot read exactly', () => {
    assert.equal(multiplyDecimals('1e3', '2'), undefined);
    assert.equal(multiplyDecimals('2', '1 000'), undefined);
  });
});
