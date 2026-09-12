import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveNeeds,
  type CoverageTarget,
  type NeedDerivation,
  type OpenCommitment,
  type StockPosition,
} from '../src/derive-needs.ts';

const target: CoverageTarget = { sourceCode: 'SKU-1', targetQuantity: '20', unit: 'box' };

function position(overrides: Partial<StockPosition> = {}): StockPosition {
  return { sourceCode: 'SKU-1', onHand: '5', unit: 'box', stale: false, ...overrides };
}

function commitment(overrides: Partial<OpenCommitment> = {}): OpenCommitment {
  return { commitmentId: 'c-1', sourceCode: 'SKU-1', quantity: '3', unit: 'box', ...overrides };
}

function rejectionOf(result: NeedDerivation): string {
  assert.equal(result.kind, 'rejected', result.kind);
  return result.kind === 'rejected' ? result.reason : '';
}

function withholdingOf(result: NeedDerivation): string {
  assert.equal(result.kind, 'derived', result.kind);
  if (result.kind !== 'derived') {
    return '';
  }
  assert.equal(result.needs.length, 0, JSON.stringify(result.needs));
  return result.withheld[0]?.reason ?? '';
}

describe('need derivation refuses ambiguous input', () => {
  it('rejects a repeated position rather than letting the last one win', () => {
    const result = deriveNeeds(
      [target],
      [position({ onHand: '5' }), position({ onHand: '100' })],
      [],
    );

    assert.equal(rejectionOf(result), 'duplicate_position');
  });

  it('rejects a repeated position whichever order it arrives in', () => {
    const forward = deriveNeeds([target], [position({ onHand: '5' }), position({ onHand: '100' })], []);
    const reversed = deriveNeeds([target], [position({ onHand: '100' }), position({ onHand: '5' })], []);

    assert.deepEqual(forward, reversed);
    assert.equal(rejectionOf(reversed), 'duplicate_position');
  });

  it('rejects a repeated coverage target', () => {
    const result = deriveNeeds(
      [target, { ...target, targetQuantity: '50' }],
      [position()],
      [],
    );

    assert.equal(rejectionOf(result), 'duplicate_target');
  });

  it('rejects two commitments claiming one identity', () => {
    const result = deriveNeeds([target], [position()], [commitment(), commitment({ quantity: '9' })]);

    assert.equal(rejectionOf(result), 'duplicate_commitment');
  });

  it('still sums genuinely distinct commitments for one product', () => {
    const result = deriveNeeds(
      [target],
      [position()],
      [commitment({ commitmentId: 'c-1', quantity: '6' }), commitment({ commitmentId: 'c-2', quantity: '4' })],
    );

    assert.equal(result.kind, 'derived');
    assert.equal(result.kind === 'derived' ? result.needs[0]?.onOrder : '', '10');
    assert.equal(result.kind === 'derived' ? result.needs[0]?.shortfall : '', '5');
  });
});

describe('need derivation refuses impossible quantities', () => {
  it('withholds stock that claims to be below empty', () => {
    assert.equal(withholdingOf(deriveNeeds([target], [position({ onHand: '-1' })], [])), 'negative_quantity');
  });

  it('withholds a commitment for a negative amount', () => {
    assert.equal(
      withholdingOf(deriveNeeds([target], [position()], [commitment({ quantity: '-3' })])),
      'negative_quantity',
    );
  });

  it('withholds a target that asks for less than nothing', () => {
    assert.equal(
      withholdingOf(deriveNeeds([{ ...target, targetQuantity: '-5' }], [position()], [])),
      'negative_quantity',
    );
  });

  it('accepts a target of zero as a decision not to stock', () => {
    const result = deriveNeeds([{ ...target, targetQuantity: '0' }], [position({ onHand: '0' })], []);
    assert.equal(withholdingOf(result), 'covered');
  });
});

describe('need derivation is indifferent to input order', () => {
  const targets: readonly CoverageTarget[] = [
    { sourceCode: 'SKU-1', targetQuantity: '20', unit: 'box' },
    { sourceCode: 'SKU-2', targetQuantity: '30', unit: 'box' },
    { sourceCode: 'SKU-3', targetQuantity: '10', unit: 'box' },
  ];
  const positions: readonly StockPosition[] = [
    position({ sourceCode: 'SKU-1', onHand: '5' }),
    position({ sourceCode: 'SKU-2', onHand: '1' }),
    position({ sourceCode: 'SKU-3', onHand: '40' }),
  ];
  const commitments: readonly OpenCommitment[] = [
    commitment({ commitmentId: 'c-1', sourceCode: 'SKU-1', quantity: '2' }),
    commitment({ commitmentId: 'c-2', sourceCode: 'SKU-2', quantity: '4' }),
    commitment({ commitmentId: 'c-3', sourceCode: 'SKU-1', quantity: '1' }),
  ];

  it('produces the same answer for every permutation of its inputs', () => {
    const expected = deriveNeeds(targets, positions, commitments);
    assert.equal(expected.kind, 'derived');

    const permutations: readonly (readonly [readonly CoverageTarget[], readonly StockPosition[], readonly OpenCommitment[]])[] = [
      [[...targets].reverse(), positions, commitments],
      [targets, [...positions].reverse(), commitments],
      [targets, positions, [...commitments].reverse()],
      [[...targets].reverse(), [...positions].reverse(), [...commitments].reverse()],
    ];

    for (const [t, p, c] of permutations) {
      assert.deepEqual(deriveNeeds(t, p, c), expected);
    }
  });
});
