import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveNeeds,
  type CoverageTarget,
  type OpenCommitment,
  type StockPosition,
} from '../src/derive-needs.ts';

const target: CoverageTarget = { sourceCode: 'SKU-1', targetQuantity: '20', unit: 'box' };

function position(overrides: Partial<StockPosition> = {}): StockPosition {
  return { sourceCode: 'SKU-1', onHand: '5', unit: 'box', stale: false, ...overrides };
}

function shortfallFor(
  positions: readonly StockPosition[],
  commitments: readonly OpenCommitment[] = [],
  targets: readonly CoverageTarget[] = [target],
): string {
  const result = deriveNeeds(targets, positions, commitments);
  assert.equal(result.needs.length, 1, JSON.stringify(result.withheld));
  return result.needs[0]?.shortfall ?? '';
}

function withholdingFor(
  positions: readonly StockPosition[],
  commitments: readonly OpenCommitment[] = [],
  targets: readonly CoverageTarget[] = [target],
): string {
  const result = deriveNeeds(targets, positions, commitments);
  assert.equal(result.needs.length, 0, JSON.stringify(result.needs));
  return result.withheld[0]?.reason ?? '';
}

describe('need derivation', () => {
  it('asks for the difference between what is wanted and what is held', () => {
    assert.equal(shortfallFor([position()]), '15');
    assert.equal(shortfallFor([position({ onHand: '0' })]), '20');
    assert.equal(shortfallFor([position({ onHand: '19.5' })]), '0.5');
  });

  it('subtracts what is already on order, so nothing is bought twice', () => {
    assert.equal(shortfallFor([position()], [{ sourceCode: 'SKU-1', quantity: '10', unit: 'box' }]), '5');
    assert.equal(
      shortfallFor([position()], [
        { sourceCode: 'SKU-1', quantity: '6', unit: 'box' },
        { sourceCode: 'SKU-1', quantity: '4', unit: 'box' },
      ]),
      '5',
    );
    assert.equal(
      shortfallFor([position()], [{ sourceCode: 'SKU-OTHER', quantity: '10', unit: 'box' }]),
      '15',
    );
  });

  it('computes the difference exactly rather than through a float', () => {
    assert.equal(
      shortfallFor(
        [position({ onHand: '0.1' })],
        [{ sourceCode: 'SKU-1', quantity: '0.2', unit: 'box' }],
        [{ sourceCode: 'SKU-1', targetQuantity: '0.6', unit: 'box' }],
      ),
      '0.3',
    );
  });

  it('reports what it read, so a need can be explained without recomputing it', () => {
    const result = deriveNeeds([target], [position()], [{ sourceCode: 'SKU-1', quantity: '3', unit: 'box' }]);
    assert.deepEqual(result.needs[0], {
      sourceCode: 'SKU-1',
      unit: 'box',
      onHand: '5',
      onOrder: '3',
      target: '20',
      shortfall: '12',
    });
  });

  it('orders its output so two identical inputs produce one answer', () => {
    const targets: readonly CoverageTarget[] = [
      { sourceCode: 'SKU-2', targetQuantity: '10', unit: 'box' },
      { sourceCode: 'SKU-1', targetQuantity: '10', unit: 'box' },
    ];
    const positions = [position({ sourceCode: 'SKU-2' }), position({ sourceCode: 'SKU-1' })];
    const result = deriveNeeds(targets, positions, []);

    assert.deepEqual(result.needs.map((need) => need.sourceCode), ['SKU-1', 'SKU-2']);
  });
});

describe('what need derivation refuses to guess', () => {
  it('never reads a missing observation as empty shelves', () => {
    assert.equal(withholdingFor([]), 'no_observation');
    assert.equal(withholdingFor([position({ sourceCode: 'SKU-OTHER' })]), 'no_observation');
  });

  it('never orders against stock it knows is out of date', () => {
    assert.equal(withholdingFor([position({ stale: true })]), 'stale_observation');
  });

  it('withholds rather than converting between units', () => {
    assert.equal(withholdingFor([position({ unit: 'strip' })]), 'unit_mismatch');
    assert.equal(
      withholdingFor([position()], [{ sourceCode: 'SKU-1', quantity: '3', unit: 'strip' }]),
      'unit_mismatch',
    );
  });

  it('withholds a position already covered by stock or by open orders', () => {
    assert.equal(withholdingFor([position({ onHand: '20' })]), 'covered');
    assert.equal(withholdingFor([position({ onHand: '25' })]), 'covered');
    assert.equal(
      withholdingFor([position({ onHand: '5' })], [{ sourceCode: 'SKU-1', quantity: '15', unit: 'box' }]),
      'covered',
    );
  });

  it('withholds anything it cannot read as an exact quantity', () => {
    assert.equal(withholdingFor([position({ onHand: '1,000' })]), 'unreadable_amount');
    assert.equal(
      withholdingFor([position()], [], [{ sourceCode: 'SKU-1', targetQuantity: '1e2', unit: 'box' }]),
      'unreadable_amount',
    );
    assert.equal(
      withholdingFor([position()], [{ sourceCode: 'SKU-1', quantity: 'lots', unit: 'box' }]),
      'unreadable_amount',
    );
  });

  it('reports every withheld position rather than only the first', () => {
    const targets: readonly CoverageTarget[] = [
      { sourceCode: 'SKU-1', targetQuantity: '10', unit: 'box' },
      { sourceCode: 'SKU-2', targetQuantity: '10', unit: 'box' },
    ];
    const result = deriveNeeds(targets, [position({ stale: true })], []);

    assert.equal(result.needs.length, 0);
    assert.deepEqual(result.withheld, [
      { sourceCode: 'SKU-1', reason: 'stale_observation' },
      { sourceCode: 'SKU-2', reason: 'no_observation' },
    ]);
  });
});
