import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDecimals,
  ceilDecimal,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  subtractDecimals,
} from '../src/exact-decimal.ts';

describe('exact decimal division at a declared scale', () => {
  it('divides to the scale the caller asks for', () => {
    assert.equal(divideDecimals('10', '4', 2), '2.5');
    assert.equal(divideDecimals('1', '3', 6), '0.333333');
    assert.equal(divideDecimals('1', '8', 3), '0.125');
  });

  it('rounds the remainder half away from zero rather than truncating it', () => {
    assert.equal(divideDecimals('2', '3', 0), '1');
    assert.equal(divideDecimals('1', '3', 0), '0');
    assert.equal(divideDecimals('1', '2', 0), '1');
    assert.equal(divideDecimals('-1', '2', 0), '-1');
  });

  it('keeps the sign of the quotient', () => {
    assert.equal(divideDecimals('-10', '4', 2), '-2.5');
    assert.equal(divideDecimals('10', '-4', 2), '-2.5');
    assert.equal(divideDecimals('-10', '-4', 2), '2.5');
  });

  it('refuses division by zero and anything it cannot read', () => {
    assert.equal(divideDecimals('1', '0', 2), undefined);
    assert.equal(divideDecimals('1', '0.0', 2), undefined);
    assert.equal(divideDecimals('1e3', '2', 2), undefined);
    assert.equal(divideDecimals('1', '2', -1), undefined);
    assert.equal(divideDecimals('1', '2', 64), undefined);
  });
});

describe('exact decimal ceiling', () => {
  it('rounds up to a whole unit, because part of a box cannot be ordered', () => {
    assert.equal(ceilDecimal('3.7'), '4');
    assert.equal(ceilDecimal('3.0001'), '4');
    assert.equal(ceilDecimal('0.0001'), '1');
  });

  it('leaves whole values alone', () => {
    assert.equal(ceilDecimal('3'), '3');
    assert.equal(ceilDecimal('3.0'), '3');
    assert.equal(ceilDecimal('0'), '0');
  });

  it('rounds towards zero on the negative side, as a ceiling does', () => {
    assert.equal(ceilDecimal('-3.7'), '-3');
    assert.equal(ceilDecimal('-0.5'), '0');
  });

  it('refuses what it cannot read', () => {
    assert.equal(ceilDecimal('abc'), undefined);
    assert.equal(ceilDecimal('1e3'), undefined);
  });
});

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
