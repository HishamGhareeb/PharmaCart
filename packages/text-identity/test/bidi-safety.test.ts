import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inspectBidirectionalText,
  inspectIdentifierText,
  isolateIdentifier,
  stripDirectionalFormatting,
} from '../src/bidi-safety.ts';

const RLO = '\u202e';
const LRO = '\u202d';
const RLE = '\u202b';
const PDF = '\u202c';
const LRI = '\u2066';
const PDI = '\u2069';
const RLM = '\u200f';
const ZWJ = '\u200d';

const ARABIC_NAME = 'باراسيتامول ٥٠٠ مجم';

function textRejection(value: string): string {
  const result = inspectBidirectionalText(value);
  assert.equal(result.kind, 'rejected', `expected rejection for ${JSON.stringify(value)}`);
  return result.kind === 'rejected' ? result.reason : '';
}

function identifierRejection(value: string): string {
  const result = inspectIdentifierText(value);
  assert.equal(result.kind, 'rejected', `expected rejection for ${JSON.stringify(value)}`);
  return result.kind === 'rejected' ? result.reason : '';
}

describe('bidirectional control inspection', () => {
  it('accepts plain Latin, plain Arabic and ordinary mixed text', () => {
    assert.equal(inspectBidirectionalText('SKU-1 Syntheticol 10 mg').kind, 'accepted');
    assert.equal(inspectBidirectionalText(ARABIC_NAME).kind, 'accepted');
    assert.equal(inspectBidirectionalText(`${ARABIC_NAME} SKU-1`).kind, 'accepted');
  });

  it('reports which scripts a label actually mixes', () => {
    const mixed = inspectBidirectionalText(`${ARABIC_NAME} SKU-1`);
    assert.equal(mixed.kind === 'accepted' ? mixed.mixed : false, true);

    const latin = inspectBidirectionalText('SKU-1');
    assert.equal(latin.kind === 'accepted' ? latin.hasRightToLeft : true, false);

    const arabic = inspectBidirectionalText(ARABIC_NAME);
    assert.equal(arabic.kind === 'accepted' ? arabic.hasLeftToRight : true, false);
  });

  it('does not mistake a byte order mark for right-to-left script', () => {
    const bom = inspectBidirectionalText('\ufeff');
    assert.equal(bom.kind === 'accepted' ? bom.hasRightToLeft : true, false);
  });

  it('refuses the directional overrides that make text read differently than it is', () => {
    assert.equal(textRejection(`SKU-${RLO}1-CBA`), 'directional_override');
    assert.equal(textRejection(`SKU${LRO}-1`), 'directional_override');
    assert.equal(textRejection(`SKU${RLE}-1${PDF}`), 'directional_override');
  });

  it('refuses isolates and invisible marks arriving in vendor data', () => {
    assert.equal(textRejection(`${LRI}SKU-1${PDI}`), 'directional_isolate');
    assert.equal(textRejection(`SKU-1${RLM}`), 'directional_mark');
  });

  it('refuses text beyond the inspection budget', () => {
    assert.equal(textRejection('a'.repeat(4097)), 'text_too_long');
  });
});

describe('identifier display isolation', () => {
  it('recovers the identifier exactly from its isolated form', () => {
    for (const code of ['SKU-1', 'ABC-0001-X', '007']) {
      assert.equal(stripDirectionalFormatting(isolateIdentifier(code)), code);
    }
  });

  it('keeps the identifier intact inside a right-to-left label', () => {
    const label = `${ARABIC_NAME} ${isolateIdentifier('SKU-1')}`;
    assert.equal(stripDirectionalFormatting(label).endsWith('SKU-1'), true);
    assert.equal(stripDirectionalFormatting(label).includes('SKU-1'), true);
  });

  it('wraps with isolates rather than overrides, so nesting cannot leak', () => {
    const isolated = isolateIdentifier('SKU-1');
    assert.equal(isolated.startsWith(LRI), true);
    assert.equal(isolated.endsWith(PDI), true);
    assert.equal(isolated.includes(RLO), false);
    assert.equal(isolated.includes(PDF), false);
  });

  it('refuses to isolate something that is not a safe identifier', () => {
    assert.throws(() => isolateIdentifier(`SKU${RLO}1`), /identifier/);
  });
});

describe('identifier text safety', () => {
  it('accepts opaque vendor codes in either script', () => {
    assert.equal(inspectIdentifierText('SKU-1').kind, 'accepted');
    assert.equal(inspectIdentifierText('ABC123').kind, 'accepted');
    assert.equal(inspectIdentifierText('دواء-12').kind, 'accepted');
  });

  it('refuses digits that only look like the digits they are not', () => {
    assert.equal(identifierRejection('SKU-٥٠٠'), 'non_ascii_digit');
    assert.equal(identifierRejection('SKU-۵۰۰'), 'non_ascii_digit');
  });

  it('refuses invisible characters that split one identity into two', () => {
    assert.equal(identifierRejection(`SKU${ZWJ}-1`), 'invisible_character');
    assert.equal(identifierRejection(`SKU-1${RLM}`), 'directional_mark');
    assert.equal(identifierRejection(`SKU${RLO}-1`), 'directional_override');
  });

  it('refuses an empty or oversized identifier', () => {
    assert.equal(identifierRejection(''), 'empty_identifier');
    assert.equal(identifierRejection('a'.repeat(257)), 'identifier_too_long');
  });
});
