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

const clean: readonly StockObservation[] = [observed(0, '100'), observed(10, '50')];

function refusal(
  observations: readonly StockObservation[],
  receipts: readonly StockReceipt[] = [],
  override: Partial<CoveragePolicy> = {},
): string {
  const result = deriveCoverageTarget('SKU-1', observations, receipts, { ...policy, ...override });
  assert.equal(result.kind, 'refused', result.kind === 'derived' ? 'derived' : '');
  return result.kind === 'refused' ? result.reason : '';
}

describe('coverage derivation refuses malformed history', () => {
  it('refuses a receipt whose timestamp cannot be read, instead of skipping it', () => {
    assert.equal(
      refusal(clean, [{ receivedAt: 'not-a-time', quantity: '10', unit: 'box' }]),
      'invalid_receipt_time',
    );
  });

  it('still checks a receipt that falls outside every observation window', () => {
    assert.equal(refusal(clean, [received(100, '1,000')]), 'unreadable_amount');
    assert.equal(refusal(clean, [received(-5, '-20')]), 'negative_quantity');
    assert.equal(
      refusal(clean, [{ receivedAt: 'not-a-time', quantity: '10', unit: 'box' }, received(5, '10')]),
      'invalid_receipt_time',
    );
  });

  it('counts an out-of-window receipt as no delivery once it is known to be valid', () => {
    const result = deriveCoverageTarget('SKU-1', clean, [received(-5, '20')], policy);
    assert.equal(result.kind, 'derived', result.kind === 'refused' ? result.reason : '');
    assert.equal(result.kind === 'derived' ? result.target.dailyConsumption : '', '5');
  });

  it('refuses stock or deliveries below zero', () => {
    assert.equal(refusal([observed(0, '-5'), observed(10, '-50')]), 'negative_quantity');
    assert.equal(refusal(clean, [received(5, '-20')]), 'negative_quantity');
  });

  it('refuses an observation timestamp it cannot read, before using the interval', () => {
    assert.equal(
      refusal([observed(0, '100'), { observedAt: 'not-a-time', onHand: '50', unit: 'box' }]),
      'unordered_history',
    );
  });
});

describe('coverage policy is validated as a whole, not field by field', () => {
  it('refuses a coverage horizon nobody could plan against', () => {
    assert.equal(refusal(clean, [], { leadTimeDays: 4000 }), 'invalid_policy');
    assert.equal(
      refusal(clean, [], { leadTimeDays: 1800, reviewPeriodDays: 1800, safetyDays: 1800 }),
      'invalid_policy',
    );
  });

  it('refuses day counts that cannot be summed safely', () => {
    assert.equal(
      refusal(clean, [], {
        leadTimeDays: Number.MAX_SAFE_INTEGER,
        reviewPeriodDays: Number.MAX_SAFE_INTEGER,
      }),
      'invalid_policy',
    );
  });

  it('still accepts a horizon at the boundary', () => {
    const result = deriveCoverageTarget('SKU-1', clean, [], {
      ...policy,
      leadTimeDays: 3650,
      reviewPeriodDays: 0,
      safetyDays: 0,
    });
    assert.equal(result.kind, 'derived', result.kind === 'refused' ? result.reason : '');
    assert.equal(result.kind === 'derived' ? result.target.coverageDays : 0, 3650);
  });
});
