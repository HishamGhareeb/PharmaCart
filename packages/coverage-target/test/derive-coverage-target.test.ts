import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveCoverageTarget,
  type CoveragePolicy,
  type StockObservation,
  type StockReceipt,
} from '../src/derive-coverage-target.ts';

const EPOCH = Date.parse('2026-08-01T00:00:00Z');

function at(days: number): string {
  return new Date(EPOCH + days * 86_400_000).toISOString();
}

function observed(days: number, onHand: string, unit = 'box'): StockObservation {
  return { observedAt: at(days), onHand, unit };
}

function received(days: number, quantity: string, unit = 'box'): StockReceipt {
  return { receivedAt: at(days), quantity, unit };
}

const policy: CoveragePolicy = {
  leadTimeDays: 3,
  reviewPeriodDays: 2,
  safetyDays: 2,
  minimumIntervals: 1,
  rateScale: 6,
};

function derived(
  observations: readonly StockObservation[],
  receipts: readonly StockReceipt[] = [],
  override: Partial<CoveragePolicy> = {},
) {
  const result = deriveCoverageTarget('SKU-1', observations, receipts, { ...policy, ...override });
  assert.equal(result.kind, 'derived', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'derived' ? result.target : (undefined as never);
}

function refusal(
  observations: readonly StockObservation[],
  receipts: readonly StockReceipt[] = [],
  override: Partial<CoveragePolicy> = {},
): string {
  const result = deriveCoverageTarget('SKU-1', observations, receipts, { ...policy, ...override });
  assert.equal(result.kind, 'refused', result.kind === 'derived' ? 'derived' : '');
  return result.kind === 'refused' ? result.reason : '';
}

describe('coverage target derivation', () => {
  it('reads consumption from the fall in stock over time', () => {
    const target = derived([observed(0, '100'), observed(10, '50')]);

    assert.equal(target.dailyConsumption, '5');
    assert.equal(target.coverageDays, 7);
    assert.equal(target.targetQuantity, '35');
  });

  it('adds back what was delivered, so a receipt is not read as negative demand', () => {
    const target = derived([observed(0, '100'), observed(10, '120')], [received(5, '50')]);

    assert.equal(target.dailyConsumption, '3');
    assert.equal(target.targetQuantity, '21');
  });

  it('rounds the target up, because part of a box cannot be ordered', () => {
    const target = derived([observed(0, '20'), observed(3, '10')]);

    assert.equal(target.dailyConsumption, '3.333333');
    assert.equal(target.targetQuantity, '24');
  });

  it('reports what it used, so a target can be argued with', () => {
    const target = derived([observed(0, '100'), observed(10, '50')]);

    assert.equal(target.sourceCode, 'SKU-1');
    assert.equal(target.unit, 'box');
    assert.equal(target.observedDays, '10');
    assert.equal(target.intervalsUsed, 1);
    assert.equal(target.intervalsCensored, 0);
  });
});

describe('stockouts censor demand rather than measure it', () => {
  const history: readonly StockObservation[] = [
    observed(0, '100'),
    observed(10, '20'),
    observed(20, '0'),
    observed(30, '60'),
  ];
  const receipts: readonly StockReceipt[] = [received(25, '60')];

  it('excludes intervals that began or ended empty', () => {
    const target = derived(history, receipts);

    assert.equal(target.intervalsUsed, 1);
    assert.equal(target.intervalsCensored, 2);
    assert.equal(target.dailyConsumption, '8');
  });

  it('would have understated demand badly had it averaged everything', () => {
    const target = derived(history, receipts);
    const naiveRate = '3.333333';

    assert.notEqual(target.dailyConsumption, naiveRate);
    assert.equal(target.targetQuantity, '56');
  });

  it('refuses outright when every interval is censored', () => {
    assert.equal(refusal([observed(0, '0'), observed(10, '0')]), 'all_intervals_censored');
  });
});

describe('what coverage derivation refuses to guess', () => {
  it('refuses history too short to mean anything', () => {
    assert.equal(refusal([observed(0, '100')]), 'insufficient_history');
    assert.equal(refusal([]), 'insufficient_history');
    assert.equal(
      refusal([observed(0, '100'), observed(10, '50')], [], { minimumIntervals: 3 }),
      'insufficient_history',
    );
  });

  it('refuses history that does not move forwards', () => {
    assert.equal(refusal([observed(10, '100'), observed(0, '50')]), 'unordered_history');
    assert.equal(refusal([observed(0, '100'), observed(0, '50')]), 'unordered_history');
    assert.equal(refusal([observed(0, '100'), { observedAt: 'not-a-time', onHand: '50', unit: 'box' }]), 'unordered_history');
  });

  it('refuses stock that appeared without a recorded delivery', () => {
    assert.equal(refusal([observed(0, '50'), observed(10, '80')]), 'negative_consumption');
  });

  it('refuses to compare or add across units', () => {
    assert.equal(refusal([observed(0, '100'), observed(10, '50', 'strip')]), 'unit_mismatch');
    assert.equal(
      refusal([observed(0, '100'), observed(10, '50')], [received(5, '10', 'strip')]),
      'unit_mismatch',
    );
  });

  it('refuses quantities and policies it cannot read', () => {
    assert.equal(refusal([observed(0, '1,000'), observed(10, '50')]), 'unreadable_amount');
    assert.equal(refusal([observed(0, '100'), observed(10, '50')], [received(5, 'lots')]), 'unreadable_amount');
    assert.equal(refusal([observed(0, '100'), observed(10, '50')], [], { leadTimeDays: -1 }), 'invalid_policy');
    assert.equal(refusal([observed(0, '100'), observed(10, '50')], [], { safetyDays: 1.5 }), 'invalid_policy');
    assert.equal(
      refusal([observed(0, '100'), observed(10, '50')], [], {
        leadTimeDays: 0, reviewPeriodDays: 0, safetyDays: 0,
      }),
      'invalid_policy',
    );
  });
});
