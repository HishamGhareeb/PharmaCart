import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isCanonicalDecimalString } from '../../contracts/src/decimal.ts';
import { canonicaliseDecimal } from '../src/canonical-decimal.ts';

describe('exact decimal canonicalisation', () => {
  it('strips redundant zeros so equivalent transport spellings converge', () => {
    assert.equal(canonicaliseDecimal('12.500'), '12.5');
    assert.equal(canonicaliseDecimal('12.5'), '12.5');
    assert.equal(canonicaliseDecimal('012'), '12');
    assert.equal(canonicaliseDecimal('12.000'), '12');
    assert.equal(canonicaliseDecimal('0.50'), '0.5');
    assert.equal(canonicaliseDecimal('00.500'), '0.5');
  });

  it('collapses every spelling of zero, including negative zero', () => {
    assert.equal(canonicaliseDecimal('0'), '0');
    assert.equal(canonicaliseDecimal('000'), '0');
    assert.equal(canonicaliseDecimal('0.0'), '0');
    assert.equal(canonicaliseDecimal('-0.000'), '0');
    assert.equal(canonicaliseDecimal('-0'), '0');
  });

  it('accepts unambiguous shorthand a spreadsheet export produces', () => {
    assert.equal(canonicaliseDecimal('.5'), '0.5');
    assert.equal(canonicaliseDecimal('12.'), '12');
    assert.equal(canonicaliseDecimal('-.250'), '-0.25');
  });

  it('preserves precision no floating point could survive', () => {
    const wide = '1234567890123456789012345.000000001';
    assert.equal(canonicaliseDecimal(wide), wide);
    assert.equal(canonicaliseDecimal('0.10000000000000000555'), '0.10000000000000000555');
  });

  it('always produces a string the contract validator accepts', () => {
    for (const raw of ['12.500', '012', '-0.000', '.5', '0.0', '9', '-5.50']) {
      const canonical = canonicaliseDecimal(raw);
      assert.notEqual(canonical, undefined, `expected ${raw} to canonicalise`);
      assert.equal(isCanonicalDecimalString(canonical), true, `${raw} produced ${canonical}`);
    }
  });

  it('refuses ambiguous, padded and machine-formatted numbers', () => {
    for (const raw of ['', ' 12', '12 ', '+12', '1,234.5', '1 234', '1e5', '1E5', '0x10']) {
      assert.equal(canonicaliseDecimal(raw), undefined, `expected ${JSON.stringify(raw)} refused`);
    }
  });

  it('refuses values that are not decimals at all', () => {
    for (const raw of ['abc', '--1', '1.2.3', '.', '-', 'Infinity', 'NaN', '١٢']) {
      assert.equal(canonicaliseDecimal(raw), undefined, `expected ${JSON.stringify(raw)} refused`);
    }
  });

  it('refuses values beyond the contract length budget', () => {
    assert.equal(canonicaliseDecimal(`${'9'.repeat(200)}`), undefined);
  });
});
