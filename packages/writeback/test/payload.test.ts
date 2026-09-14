import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertWritebackPayload,
  canonicalJson,
  syntheticSinkKey,
  syntheticStockReceiptToken,
  writebackLimits,
  writebackPayloadHash,
  WritebackPayloadError,
  type WritebackPayload,
} from '../src/payload.ts';

// The payload is the only thing the synthetic sink is ever told, and its hash is the evidence that
// decides whether a writeback may be marked applied. These tests pin three properties: the identity
// and hash are stable across restarts and key orderings, every quantity stays an exact decimal taken
// verbatim from the immutable order snapshot, and anything malformed, oversized or numerically out of
// range is refused before it can reach a sink or a comparison.

const nul = String.fromCharCode(0);

const identity = {
  brand: 'SYN Brand',
  manufacturer: 'SYN Maker',
  strength: '5 mg',
  dosageForm: 'tablet',
  packSize: { value: '20', unit: 'tablet' },
  saleUnit: 'box',
};

function payload(overrides: Partial<WritebackPayload> = {}): WritebackPayload {
  return assertWritebackPayload({
    writebackId: 'b1000000-0000-4000-8000-000000000001',
    receiptId: 'b2000000-0000-4000-8000-000000000001',
    intentId: 'b3000000-0000-4000-8000-000000000001',
    organisationId: '10000000-0000-4000-8000-000000000001',
    branchId: '20000000-0000-4000-8000-000000000001',
    reference: 'receipt-stable',
    lines: [{
      lineId: 'b4000000-0000-4000-8000-000000000001',
      needId: '40000000-0000-4000-8000-000000000001',
      quantity: '1',
      packIdentity: identity,
    }],
    ...overrides,
  });
}

function invalid(value: unknown, because: string) {
  assert.throws(() => assertWritebackPayload(value), (error: unknown) => {
    assert.ok(error instanceof WritebackPayloadError, `expected a payload refusal for ${because}`);
    assert.equal(error.code, 'WRITEBACK_PAYLOAD_INVALID');
    assert.ok(error.detail.length > 0, 'a refusal must name the offending field for an operator');
    return true;
  }, `expected ${because} to be refused`);
}

test('the sink key and payload hash are stable and independent of key ordering', () => {
  const key = syntheticSinkKey(payload());
  assert.ok(key.startsWith('pc-syn-wb-'), `a synthetic key must be recognisable, got ${key}`);
  assert.equal(key, syntheticSinkKey(payload()), 'the key must be derived, never minted per attempt');

  // A jsonb column returns object keys in storage order, which is not the insertion order. A hash that
  // depended on it would flip to "changed payload" after a dump and restore and refuse a valid writeback.
  const reordered = payload({
    lines: [{
      packIdentity: { saleUnit: 'box', packSize: { unit: 'tablet', value: '20' }, dosageForm: 'tablet', strength: '5 mg', manufacturer: 'SYN Maker', brand: 'SYN Brand' },
      quantity: '1',
      needId: '40000000-0000-4000-8000-000000000001',
      lineId: 'b4000000-0000-4000-8000-000000000001',
    }],
  });
  assert.equal(writebackPayloadHash(reordered), writebackPayloadHash(payload()),
    'an equal payload must hash equally however its keys were ordered');
  assert.match(writebackPayloadHash(payload()), /^[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('the sink key is scoped to one tenant and one receipt', () => {
  const base = syntheticSinkKey(payload());
  for (const overrides of [
    { organisationId: '10000000-0000-4000-8000-000000000002' },
    { branchId: '20000000-0000-4000-8000-000000000002' },
    { receiptId: 'b2000000-0000-4000-8000-000000000002' },
  ]) {
    assert.notEqual(syntheticSinkKey(payload(overrides)), base,
      `${JSON.stringify(overrides)} must not share a stock receipt key`);
  }
  // The key deliberately ignores the writeback row identity: a restore that re-derives the queue row
  // must resolve to the same stock receipt rather than creating a second one.
  assert.equal(syntheticSinkKey(payload({ writebackId: 'b1000000-0000-4000-8000-000000000009' })), base);
});

test('any change to a quantity, need or pack identity changes the hash', () => {
  const base = writebackPayloadHash(payload());
  const line = { lineId: 'b4000000-0000-4000-8000-000000000001', needId: '40000000-0000-4000-8000-000000000001', quantity: '1', packIdentity: identity };
  const variants: Partial<WritebackPayload>[] = [
    { reference: 'receipt-other' },
    { intentId: 'b3000000-0000-4000-8000-000000000002' },
    { lines: [{ ...line, quantity: '2' }] },
    { lines: [{ ...line, needId: '40000000-0000-4000-8000-000000000002' }] },
    { lines: [{ ...line, lineId: 'b4000000-0000-4000-8000-000000000002' }] },
    { lines: [{ ...line, packIdentity: { ...identity, strength: '10 mg' } }] },
    { lines: [{ ...line, packIdentity: { ...identity, packSize: { value: '30', unit: 'tablet' } } }] },
    { lines: [{ ...line, packIdentity: { ...identity, packSize: { value: '20', unit: 'capsule' } } }] },
    { lines: [line, { ...line, lineId: 'b4000000-0000-4000-8000-000000000003' }] },
  ];
  for (const overrides of variants) {
    assert.notEqual(writebackPayloadHash(payload(overrides)), base,
      `${JSON.stringify(overrides)} must be visible in the payload hash`);
  }
});

test('quantities keep their exact decimal form and are never normalised or converted', () => {
  // '1' and '1.0' are the same number but not the same recorded quantity. Normalising either way would
  // silently rewrite what the receiver confirmed, so a non-canonical form is refused rather than fixed.
  const one = payload();
  assert.equal(one.lines[0]!.quantity, '1');
  invalid({ ...one, lines: [{ ...one.lines[0]!, quantity: '1.0' }] }, 'a non-canonical trailing zero');

  // A float can never represent an exact decimal quantity, so a number is refused rather than coerced.
  for (const quantity of [1, 1.5, '0', '-1', '', ' 1', '1,5', '0x1', '1e3', 'Infinity', 'NaN', null, '.5', '1.']) {
    invalid({ ...one, lines: [{ ...one.lines[0]!, quantity }] }, `quantity ${JSON.stringify(quantity)}`);
  }
  // Fractional pack quantities remain exact to the documented scale.
  assert.equal(payload({ lines: [{ ...one.lines[0]!, quantity: '0.5' }] }).lines[0]!.quantity, '0.5');
});

test('quantities outside the durable numeric range are refused, not truncated', () => {
  const one = payload();
  const line = one.lines[0]!;
  const digits = writebackLimits.quantity.maxIntegerDigits;
  // order_line constrains every quantity below 1e12; a larger value can never match a durable row, so
  // refusing here keeps the failure at the boundary instead of inside the database or the sink.
  assert.equal(payload({ lines: [{ ...line, quantity: '9'.repeat(digits) }] }).lines[0]!.quantity, '9'.repeat(digits));
  invalid({ ...one, lines: [{ ...line, quantity: `1${'0'.repeat(digits)}` }] }, 'a quantity at or above the numeric bound');
  invalid({ ...one, lines: [{ ...line, quantity: '9'.repeat(digits + 6) }] }, 'a quantity far above the numeric bound');
  invalid({ ...one, lines: [{ ...line, quantity: `1.${'1'.repeat(writebackLimits.quantity.maxFractionDigits + 1)}` }] },
    'more fraction digits than the recorded scale');
  invalid({ ...one, lines: [{ ...line, quantity: `1.${'1'.repeat(writebackLimits.quantity.maxLength)}` }] }, 'an oversized quantity string');
});

test('an incomplete or inferred pack identity is refused rather than reconstructed', () => {
  const one = payload();
  const line = one.lines[0]!;
  // Pack identity must arrive verbatim from the immutable order snapshot. A missing field must never be
  // filled in from a unit conversion, a default or another line.
  for (const field of ['brand', 'manufacturer', 'strength', 'dosageForm', 'saleUnit'] as const) {
    const rest = Object.fromEntries(Object.entries(identity).filter(([key]) => key !== field));
    invalid({ ...one, lines: [{ ...line, packIdentity: rest }] }, `pack identity without ${field}`);
    invalid({ ...one, lines: [{ ...line, packIdentity: { ...identity, [field]: '' } }] }, `an empty ${field}`);
    invalid({ ...one, lines: [{ ...line, packIdentity: { ...identity, [field]: 5 } }] }, `a non-string ${field}`);
  }
  for (const packSize of [undefined, null, {}, { value: '20' }, { unit: 'tablet' }, { value: 0, unit: 'tablet' },
    { value: '0', unit: 'tablet' }, { value: '20', unit: '' }, { value: '20.0', unit: 'tablet' }, 'tablet-20']) {
    invalid({ ...one, lines: [{ ...line, packIdentity: { ...identity, packSize } }] }, `packSize ${JSON.stringify(packSize)}`);
  }
  // An unexpected field means the snapshot is not the shape this sink was reviewed against.
  invalid({ ...one, lines: [{ ...line, packIdentity: { ...identity, strengthPerUnit: '2.5 mg' } }] }, 'an unknown pack identity field');
});

test('malformed, duplicated and oversized payload structures are refused', () => {
  const one = payload();
  const line = one.lines[0]!;
  for (const value of [undefined, null, 'payload', 7, [], () => undefined]) invalid(value, `a ${typeof value} payload`);
  for (const field of ['writebackId', 'receiptId', 'intentId', 'organisationId', 'branchId'] as const) {
    invalid({ ...one, [field]: 'not-a-uuid' }, `${field} that is not a UUID`);
    invalid({ ...one, [field]: '' }, `an empty ${field}`);
    invalid({ ...one, [field]: undefined }, `a missing ${field}`);
    // PostgreSQL renders uuid lowercase, so accepting a mixed-case spelling would let two spellings of
    // one identity hash differently. The chosen value carries hex letters, unlike the fixture ids.
    invalid({ ...one, [field]: 'ABCDEF12-0000-4000-8000-000000000001' }, `a non-canonical uppercase ${field}`);
    assert.equal(payload({ [field]: 'abcdef12-0000-4000-8000-000000000001' })[field], 'abcdef12-0000-4000-8000-000000000001');
  }
  invalid({ ...one, extra: true }, 'an unknown payload field');
  invalid({ ...one, reference: '' }, 'an empty reference');
  invalid({ ...one, reference: 'r'.repeat(writebackLimits.reference.maxLength + 1) }, 'an oversized reference');
  invalid({ ...one, reference: `receipt${nul}null` }, 'a reference containing a control character');
  assert.equal(payload({ reference: 'r'.repeat(writebackLimits.reference.maxLength) }).reference.length, writebackLimits.reference.maxLength);

  invalid({ ...one, lines: [] }, 'a receipt with no lines');
  invalid({ ...one, lines: line }, 'lines that are not an array');
  invalid({ ...one, lines: [line, line] }, 'a duplicated line identity');
  invalid({ ...one, lines: [{ ...line, unexpected: 1 }] }, 'an unknown line field');
  const tooMany = Array.from({ length: writebackLimits.lines.max + 1 }, (_, index) =>
    ({ ...line, lineId: `b4000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  invalid({ ...one, lines: tooMany }, 'more lines than the bound allows');

  // A single oversized text field must not be able to grow the serialised payload without limit.
  invalid({ ...one, lines: [{ ...line, packIdentity: { ...identity, brand: 'B'.repeat(writebackLimits.text.maxLength + 1) } }] },
    'an oversized pack identity field');
});

test('the stock receipt token is derived from the key and hash together', () => {
  const one = payload();
  const key = syntheticSinkKey(one);
  const hash = writebackPayloadHash(one);
  const token = syntheticStockReceiptToken(key, hash);
  assert.ok(token.startsWith('pc-syn-stock-'), `a sink receipt token must be recognisable, got ${token}`);
  assert.equal(syntheticStockReceiptToken(key, hash), token, 'the token must be reproducible after a restart');
  assert.notEqual(syntheticStockReceiptToken(key, writebackPayloadHash(payload({ reference: 'other' }))), token,
    'a token must not vouch for a payload it was not derived from');
  assert.notEqual(syntheticStockReceiptToken(syntheticSinkKey(payload({ receiptId: 'b2000000-0000-4000-8000-000000000002' })), hash), token);
  for (const bad of ['', 'not-a-key', `${key} `]) {
    assert.throws(() => syntheticStockReceiptToken(bad, hash), WritebackPayloadError, `key ${JSON.stringify(bad)} must be refused`);
  }
  for (const bad of ['', 'zz', hash.toUpperCase(), `${hash}0`]) {
    assert.throws(() => syntheticStockReceiptToken(key, bad), WritebackPayloadError, `hash ${JSON.stringify(bad)} must be refused`);
  }
});
