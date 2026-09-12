import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readDatabaseViewRows } from '../src/database-view-transport.ts';
import { readDelimitedInventoryFile } from '../src/delimited-transport.ts';
import { readJsonInventoryPayload } from '../src/json-transport.ts';
import type { TransportDecision } from '../src/transport-result.ts';

const columns = { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' } as const;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function reasonOf(decision: TransportDecision): string {
  assert.equal(decision.kind, 'rejected');
  return decision.kind === 'rejected' ? decision.reason : '';
}

function observationsOf(decision: TransportDecision) {
  assert.equal(decision.kind, 'accepted', decision.kind === 'rejected' ? decision.reason : '');
  return decision.kind === 'accepted' ? decision.observations : [];
}

describe('JSON API transport', () => {
  it('reads canonical field names from a row array', () => {
    const decision = readJsonInventoryPayload([
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
    ]);
    assert.deepEqual(observationsOf(decision), [
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
    ]);
  });

  it('refuses a JSON number quantity rather than reading it as a decimal', () => {
    assert.equal(
      reasonOf(readJsonInventoryPayload([{ sourceCode: 'SKU-1', quantity: 12.5, unit: 'box' }])),
      'non_string_value',
    );
  });

  it('refuses payloads that are not a row collection', () => {
    assert.equal(reasonOf(readJsonInventoryPayload({ rows: [] })), 'not_a_row_collection');
    assert.equal(reasonOf(readJsonInventoryPayload(null)), 'not_a_row_collection');
    assert.equal(reasonOf(readJsonInventoryPayload([null])), 'malformed_payload');
    assert.equal(reasonOf(readJsonInventoryPayload([])), 'no_data_rows');
  });

  it('refuses a row missing a canonical field', () => {
    assert.equal(
      reasonOf(readJsonInventoryPayload([{ sourceCode: 'SKU-1', unit: 'box' }])),
      'non_string_value',
    );
  });

  it('bounds the number of rows it will accept', () => {
    const many = Array.from({ length: 5 }, () => ({ sourceCode: 'SKU-1', quantity: '1', unit: 'box' }));
    assert.equal(reasonOf(readJsonInventoryPayload(many, { maxRows: 4 })), 'too_many_rows');
  });
});

describe('on-premise database view transport', () => {
  it('maps vendor column names onto canonical observations', () => {
    const decision = readDatabaseViewRows(columns, [
      { ITEM_CODE: 'SKU-1', QTY_ON_HAND: '12.5', UOM: 'BOX', IGNORED: 'x' },
    ]);
    assert.deepEqual(observationsOf(decision), [
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'BOX' },
    ]);
  });

  it('accepts a safe integer column without risking precision', () => {
    const decision = readDatabaseViewRows(columns, [
      { ITEM_CODE: 'SKU-1', QTY_ON_HAND: 12, UOM: 'BOX' },
    ]);
    assert.equal(observationsOf(decision)[0]?.quantity, '12');
  });

  it('refuses a fractional or unsafe numeric column', () => {
    assert.equal(
      reasonOf(readDatabaseViewRows(columns, [{ ITEM_CODE: 'SKU-1', QTY_ON_HAND: 12.5, UOM: 'BOX' }])),
      'non_string_value',
    );
    assert.equal(
      reasonOf(readDatabaseViewRows(columns, [{ ITEM_CODE: 'SKU-1', QTY_ON_HAND: null, UOM: 'BOX' }])),
      'non_string_value',
    );
  });

  it('refuses a view missing a mapped column', () => {
    assert.equal(
      reasonOf(readDatabaseViewRows(columns, [{ ITEM_CODE: 'SKU-1', UOM: 'BOX' }])),
      'missing_column',
    );
  });

  it('refuses an empty result set', () => {
    assert.equal(reasonOf(readDatabaseViewRows(columns, [])), 'no_data_rows');
  });
});

describe('delimited file transport', () => {
  it('reads a header-mapped file with a byte order mark and CRLF line endings', () => {
    const decision = readDelimitedInventoryFile(
      columns,
      bytes('\ufeffITEM_CODE,QTY_ON_HAND,UOM\r\nSKU-1,12.500,BOX\r\nSKU-2,7,strip\r\n'),
    );
    assert.deepEqual(observationsOf(decision), [
      { sourceCode: 'SKU-1', quantity: '12.500', unit: 'BOX' },
      { sourceCode: 'SKU-2', quantity: '7', unit: 'strip' },
    ]);
  });

  it('honours quoted fields containing the delimiter, newlines and escaped quotes', () => {
    const decision = readDelimitedInventoryFile(
      columns,
      bytes('ITEM_CODE,QTY_ON_HAND,UOM\n"SKU,1",1,box\n"SKU""2",2,box\n'),
    );
    assert.deepEqual(observationsOf(decision).map((row) => row.sourceCode), ['SKU,1', 'SKU"2']);
  });

  it('reads an alternative delimiter when the contract declares one', () => {
    const decision = readDelimitedInventoryFile(
      columns,
      bytes('ITEM_CODE\tQTY_ON_HAND\tUOM\nSKU-1\t3\tbox\n'),
      { delimiter: '\t' },
    );
    assert.equal(observationsOf(decision)[0]?.quantity, '3');
  });

  it('refuses ragged rows rather than padding them', () => {
    assert.equal(
      reasonOf(readDelimitedInventoryFile(columns, bytes('ITEM_CODE,QTY_ON_HAND,UOM\nSKU-1,3\n'))),
      'ragged_row',
    );
  });

  it('refuses an unterminated quoted field and invalid UTF-8', () => {
    assert.equal(
      reasonOf(readDelimitedInventoryFile(columns, bytes('ITEM_CODE,QTY_ON_HAND,UOM\n"SKU-1,3,box\n'))),
      'malformed_payload',
    );
    assert.equal(
      reasonOf(readDelimitedInventoryFile(columns, new Uint8Array([0xc3, 0x28]))),
      'invalid_utf8',
    );
  });

  it('refuses a missing header column, an empty file and a header-only file', () => {
    assert.equal(
      reasonOf(readDelimitedInventoryFile(columns, bytes('ITEM_CODE,UOM\nSKU-1,box\n'))),
      'missing_column',
    );
    assert.equal(reasonOf(readDelimitedInventoryFile(columns, new Uint8Array(0))), 'no_data_rows');
    assert.equal(
      reasonOf(readDelimitedInventoryFile(columns, bytes('ITEM_CODE,QTY_ON_HAND,UOM\n'))),
      'no_data_rows',
    );
  });

  it('refuses a cell carrying a formula payload at the parse edge', () => {
    assert.equal(
      reasonOf(readDelimitedInventoryFile(
        columns,
        bytes('ITEM_CODE,QTY_ON_HAND,UOM\n"=cmd|\' /c calc\'!A0",1,box\n'),
      )),
      'unsafe_cell',
    );
  });
});
