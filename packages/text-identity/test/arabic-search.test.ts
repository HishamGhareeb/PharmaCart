import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliseForSearch } from '../src/arabic-search.ts';
import { inspectIdentifierText } from '../src/bidi-safety.ts';

describe('Arabic search normalisation', () => {
  it('folds the alef variants a typist chooses between', () => {
    const forms = ['احمد', 'أحمد', 'إحمد', 'آحمد'];
    const normalised = forms.map(normaliseForSearch);
    assert.equal(new Set(normalised).size, 1, normalised.join(' '));
  });

  it('folds teh marbuta and alef maqsura to their plain forms', () => {
    assert.equal(normaliseForSearch('شربة'), normaliseForSearch('شربه'));
    assert.equal(normaliseForSearch('كبرى'), normaliseForSearch('كبري'));
  });

  it('strips decorative elongation and diacritics', () => {
    assert.equal(normaliseForSearch('بـــاراسيتامول'), normaliseForSearch('باراسيتامول'));
    assert.equal(normaliseForSearch('بَارَاسِيتَامُول'), normaliseForSearch('باراسيتامول'));
  });

  it('reads Arabic-Indic and Persian digits as the numbers they are', () => {
    assert.equal(normaliseForSearch('٥٠٠'), '500');
    assert.equal(normaliseForSearch('۵۰۰'), '500');
    assert.equal(normaliseForSearch('500'), '500');
  });

  it('folds Latin case and collapses runs of whitespace', () => {
    assert.equal(normaliseForSearch('  Syntheticol   10   MG '), 'syntheticol 10 mg');
  });

  it('lets two honest spellings of one product meet', () => {
    assert.equal(
      normaliseForSearch('بـاراسيتامول ٥٠٠ مجم'),
      normaliseForSearch('باراسيتامول 500 مجم'),
    );
  });

  it('is idempotent, so a normalised query can be normalised again', () => {
    for (const value of ['أحمد', '٥٠٠ مجم', 'Syntheticol  10 MG', 'بـــاراسيتامول']) {
      const once = normaliseForSearch(value);
      assert.equal(normaliseForSearch(once), once);
    }
  });

  it('removes invisible characters that would split a search term', () => {
    assert.equal(normaliseForSearch('باراس\u200bيتامول'), normaliseForSearch('باراسيتامول'));
    assert.equal(normaliseForSearch('SKU\u202e-1'), 'sku-1');
  });

  it('never produces something usable as an identity', () => {
    const folded = normaliseForSearch('SKU-٥٠٠');
    assert.equal(folded, 'sku-500');
    assert.notEqual(folded, 'SKU-٥٠٠');
    assert.equal(inspectIdentifierText('SKU-٥٠٠').kind, 'rejected');
  });
});
