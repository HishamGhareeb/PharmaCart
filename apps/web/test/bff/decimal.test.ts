import { describe, expect, it } from 'vitest';

import { canonicalQuantity, remainingQuantity } from '../../src/lib/decimal.ts';

describe('remaining quantity', () => {
  it('subtracts exactly and never reports a negative remainder', () => {
    expect(remainingQuantity('2', '1')).toBe('1');
    expect(remainingQuantity('2.5', '0.75')).toBe('1.75');
    expect(remainingQuantity('1', '3')).toBe('0');
  });

  it('reports a fully received line as a canonical zero', () => {
    expect(remainingQuantity('2.00', '2.00')).toBe('0');
  });

  it('refuses a value that is not a plain decimal', () => {
    expect(remainingQuantity('1', 'x')).toBeNull();
    expect(remainingQuantity('1e3', '0')).toBeNull();
  });
});

describe('operator quantity input', () => {
  // The quote and receipt schemas in packages/contracts reject a trailing fraction zero, but `1.50`
  // and `2.0` are ordinary things for a person to type and for a number input to produce. Rewriting
  // them is honest: the value is unchanged. Bouncing the operator off the API's schema refusal is
  // not, because the message names a canonical decimal the form never asked for.
  it('rewrites a trailing-zero entry into the canonical decimal the API accepts', () => {
    expect(canonicalQuantity('1.50')).toBe('1.5');
    expect(canonicalQuantity('2.0')).toBe('2');
    expect(canonicalQuantity('2.000')).toBe('2');
    expect(canonicalQuantity('0.50')).toBe('0.5');
  });

  it('leaves an already canonical entry alone and trims surrounding space', () => {
    expect(canonicalQuantity('2')).toBe('2');
    expect(canonicalQuantity(' 1.75 ')).toBe('1.75');
    expect(canonicalQuantity('120')).toBe('120');
  });

  it('strips leading zeros without changing the value', () => {
    expect(canonicalQuantity('007')).toBe('7');
    expect(canonicalQuantity('00.5')).toBe('0.5');
    expect(canonicalQuantity('0')).toBe('0');
    expect(canonicalQuantity('0.0')).toBe('0');
  });

  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const value of ['', '   ', '-1', '-0.5', '1.', '.5', '1e3', 'abc', '1,5', 'Infinity', '1 2', '+1']) {
      expect(canonicalQuantity(value)).toBeNull();
    }
  });
});
