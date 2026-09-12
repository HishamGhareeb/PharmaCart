import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveSupplierPerformance,
  type PerformancePolicy,
  type SupplierOrderRecord,
} from '../src/derive-performance.ts';

const EPOCH = Date.parse('2026-07-01T00:00:00Z');
const MS_PER_DAY = 86_400_000;

function iso(milliseconds: number): string {
  return new Date(EPOCH + milliseconds).toISOString();
}

function at(days: number): string {
  return iso(days * MS_PER_DAY);
}

const policy: PerformancePolicy = { minimumCompletedOrders: 2, rateScale: 6 };

function order(overrides: Partial<SupplierOrderRecord> = {}): SupplierOrderRecord {
  return {
    orderId: 'o-1',
    supplierId: 'sup-a',
    placedAt: at(0),
    orderedQuantity: '10',
    unit: 'box',
    outcome: { kind: 'delivered', deliveredAt: at(3), deliveredQuantity: '10' },
    ...overrides,
  };
}

const twoClean: readonly SupplierOrderRecord[] = [
  order({ orderId: 'o-1' }),
  order({ orderId: 'o-2' }),
];

function refusal(
  orders: readonly SupplierOrderRecord[],
  asOf = at(30),
  override: Partial<PerformancePolicy> = {},
): string {
  const result = deriveSupplierPerformance('sup-a', orders, { ...policy, ...override }, asOf);
  assert.equal(result.kind, 'refused', result.kind === 'derived' ? 'derived' : '');
  return result.kind === 'refused' ? result.reason : '';
}

function derived(
  orders: readonly SupplierOrderRecord[],
  asOf = at(30),
  override: Partial<PerformancePolicy> = {},
) {
  const result = deriveSupplierPerformance('sup-a', orders, { ...policy, ...override }, asOf);
  assert.equal(result.kind, 'derived', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'derived' ? result.performance : (undefined as never);
}

describe('supplier performance validates before it excludes', () => {
  it('refuses a malformed record even when its outcome would exclude it', () => {
    assert.equal(
      refusal([...twoClean, order({ orderId: 'o-3', orderedQuantity: '-5', outcome: { kind: 'unknown' } })]),
      'negative_quantity',
    );
    assert.equal(
      refusal([...twoClean, order({ orderId: 'o-3', orderedQuantity: '1,000', outcome: { kind: 'unknown' } })]),
      'unreadable_amount',
    );
    assert.equal(
      refusal([
        ...twoClean,
        order({ orderId: 'o-3', placedAt: 'not-a-time', outcome: { kind: 'cancelled_by_pharmacy' } }),
      ]),
      'unordered_timeline',
    );
  });

  it('refuses quantities that cannot describe a real delivery', () => {
    assert.equal(
      refusal([
        order({ orderId: 'o-1', outcome: { kind: 'delivered', deliveredAt: at(3), deliveredQuantity: '-1' } }),
        order({ orderId: 'o-2' }),
      ]),
      'negative_quantity',
    );
    assert.equal(
      refusal([
        order({ orderId: 'o-1', outcome: { kind: 'delivered', deliveredAt: at(3), deliveredQuantity: '11' } }),
        order({ orderId: 'o-2' }),
      ]),
      'delivered_exceeds_ordered',
    );
  });

  it('refuses a delivery timestamp it cannot read', () => {
    assert.equal(
      refusal([
        order({ orderId: 'o-1', outcome: { kind: 'delivered', deliveredAt: 'not-a-time', deliveredQuantity: '10' } }),
        order({ orderId: 'o-2' }),
      ]),
      'unordered_timeline',
    );
  });

  it('refuses an evaluation instant it cannot read', () => {
    assert.equal(refusal(twoClean, 'not-a-time'), 'unordered_timeline');
  });
});

describe('elapsed time is measured in integer milliseconds', () => {
  it('measures a lead time far below one day instead of refusing it', () => {
    const performance = derived([
      order({ orderId: 'o-1', placedAt: iso(0), outcome: { kind: 'delivered', deliveredAt: iso(1), deliveredQuantity: '10' } }),
      order({ orderId: 'o-2', placedAt: iso(0), outcome: { kind: 'delivered', deliveredAt: iso(1), deliveredQuantity: '10' } }),
    ], at(30), { rateScale: 20 });

    assert.equal(performance.observedLeadTimeDays, '0.00000001157407407407');
  });

  it('averages sub-day lead times without drifting', () => {
    const eightHours = MS_PER_DAY / 3;
    const performance = derived([
      order({ orderId: 'o-1', placedAt: iso(0), outcome: { kind: 'delivered', deliveredAt: iso(eightHours), deliveredQuantity: '10' } }),
      order({ orderId: 'o-2', placedAt: iso(0), outcome: { kind: 'delivered', deliveredAt: iso(eightHours), deliveredQuantity: '10' } }),
      order({ orderId: 'o-3', placedAt: iso(0), outcome: { kind: 'delivered', deliveredAt: iso(eightHours), deliveredQuantity: '10' } }),
    ], at(30), { rateScale: 16 });

    assert.equal(performance.observedLeadTimeDays, '0.3333333333333333');
  });
});

describe('boundaries around the sample floor and the understated flag', () => {
  it('accepts exactly the floor and refuses one below it', () => {
    assert.equal(derived(twoClean, at(30), { minimumCompletedOrders: 2 }).completedOrders, 2);
    assert.equal(refusal(twoClean, at(30), { minimumCompletedOrders: 3 }), 'insufficient_sample');
  });

  it('does not flag understatement when an outstanding order exactly equals the lead time', () => {
    const performance = derived([
      order({ orderId: 'o-1', placedAt: at(0), outcome: { kind: 'delivered', deliveredAt: at(2), deliveredQuantity: '10' } }),
      order({ orderId: 'o-2', placedAt: at(0), outcome: { kind: 'delivered', deliveredAt: at(4), deliveredQuantity: '10' } }),
      order({ orderId: 'o-3', placedAt: at(27), outcome: { kind: 'outstanding' } }),
    ], at(30));

    assert.equal(performance.observedLeadTimeDays, '3');
    assert.equal(performance.leadTimeUnderstated, false);
  });

  it('flags understatement one millisecond past the lead time', () => {
    const performance = derived([
      order({ orderId: 'o-1', placedAt: at(0), outcome: { kind: 'delivered', deliveredAt: at(2), deliveredQuantity: '10' } }),
      order({ orderId: 'o-2', placedAt: at(0), outcome: { kind: 'delivered', deliveredAt: at(4), deliveredQuantity: '10' } }),
      order({ orderId: 'o-3', placedAt: iso(27 * MS_PER_DAY - 1), outcome: { kind: 'outstanding' } }),
    ], at(30));

    assert.equal(performance.leadTimeUnderstated, true);
  });
});
