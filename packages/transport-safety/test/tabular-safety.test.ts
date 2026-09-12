import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectUntrustedCell, inspectUntrustedTable } from '../src/tabular-safety.ts';

function cellRejection(value: string): string {
  const decision = inspectUntrustedCell(value);
  assert.equal(decision.kind, 'rejected', `expected rejection for ${JSON.stringify(value)}`);
  return decision.kind === 'rejected' ? decision.reason : '';
}

function acceptsCell(value: string): boolean {
  return inspectUntrustedCell(value).kind === 'accepted';
}

describe('untrusted spreadsheet cell inspection', () => {
  it('accepts ordinary product text and exact decimal quantities', () => {
    assert.equal(acceptsCell('Syntheticol 10 mg tablet'), true);
    assert.equal(acceptsCell('120.500'), true);
    assert.equal(acceptsCell(''), true);
  });

  it('accepts signed plain numbers that only look like a formula prefix', () => {
    assert.equal(acceptsCell('-5'), true);
    assert.equal(acceptsCell('+3.5'), true);
    assert.equal(acceptsCell('-0.250'), true);
  });

  it('rejects formula, command and hyperlink prefixes', () => {
    assert.equal(cellRejection('=1+1'), 'formula_prefix');
    assert.equal(cellRejection('=HYPERLINK("http://attacker.example","click")'), 'formula_prefix');
    assert.equal(cellRejection('@SUM(A1:A9)'), 'formula_prefix');
    assert.equal(cellRejection('-2+3+cmd|\' /c calc\'!A0'), 'formula_prefix');
    assert.equal(cellRejection('+cmd|\' /c calc\'!A0'), 'formula_prefix');
  });

  it('rejects formula prefixes hidden behind whitespace or zero-width characters', () => {
    assert.equal(cellRejection(' =1+1'), 'formula_prefix');
    assert.equal(cellRejection('\t=1+1'), 'formula_prefix');
    assert.equal(cellRejection('\r=1+1'), 'formula_prefix');
    assert.equal(cellRejection('\u200b=1+1'), 'formula_prefix');
    assert.equal(cellRejection('\ufeff@SUM(A1)'), 'formula_prefix');
  });

  it('rejects embedded control characters and oversized cells', () => {
    assert.equal(cellRejection('Syntheticol\u000010 mg'), 'control_character');
    assert.equal(cellRejection('line\nbreak'), 'control_character');
    assert.equal(cellRejection('a'.repeat(32_769)), 'cell_too_long');
  });
});

describe('untrusted table bounds', () => {
  const goodRow: readonly string[] = ['SKU-1', 'Syntheticol 10 mg', '12'];

  it('accepts a bounded grid and reports its shape', () => {
    const decision = inspectUntrustedTable([goodRow, ['SKU-2', 'Syntheticol 20 mg', '4']]);
    assert.equal(decision.kind, 'accepted');
    assert.equal(decision.kind === 'accepted' ? decision.rowCount : 0, 2);
    assert.equal(decision.kind === 'accepted' ? decision.columnCount : 0, 3);
  });

  it('reports the exact coordinate of the first unsafe cell', () => {
    const decision = inspectUntrustedTable([goodRow, ['SKU-2', '=cmd|\' /c calc\'!A0', '4']]);
    assert.equal(decision.kind, 'rejected');
    assert.equal(decision.kind === 'rejected' ? decision.reason : '', 'formula_prefix');
    assert.equal(decision.kind === 'rejected' ? decision.row : -1, 1);
    assert.equal(decision.kind === 'rejected' ? decision.column : -1, 1);
  });

  it('rejects grids beyond the row and column budget', () => {
    const manyRows = Array.from({ length: 5 }, () => goodRow);
    const tooWide = Array.from({ length: 4 }, () => 'x');

    const rowDecision = inspectUntrustedTable(manyRows, { maxRows: 4 });
    assert.equal(rowDecision.kind === 'rejected' ? rowDecision.reason : '', 'too_many_rows');

    const columnDecision = inspectUntrustedTable([tooWide], { maxColumns: 3 });
    assert.equal(columnDecision.kind === 'rejected' ? columnDecision.reason : '', 'too_many_columns');
    assert.equal(columnDecision.kind === 'rejected' ? columnDecision.row : -1, 0);
  });
});
