import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveSupplierPerformance,
  type PerformancePolicy,
  type SupplierOrderRecord,
} from '../src/derive-performance.ts';

const EPOCH = Date.parse('2026-07-01T00:00:00Z');

function at(days: number): string {
  return new Date(EPOCH + days * 86_400_000).toISOString();
}

const policy: PerformancePolicy = { minimumCompletedOrders: 2, rateScale: 4 };

function delivered(
  orderId: string,
  placedDay: number,
  deliveredDay: number,
  ordered: string,
  received: string,
): SupplierOrderRecord {
  return {
    orderId,
    supplierId: 'sup-a',
    placedAt: at(placedDay),
    orderedQuantity: ordered,
    unit: 'box',
    outcome: { kind: 'delivered', deliveredAt: at(deliveredDay), deliveredQuantity: received },
  };
}

function withOutcome(
  orderId: string,
  outcome: SupplierOrderRecord['outcome'],
  placedDay = 0,
): SupplierOrderRecord {
  return {
    orderId,
    supplierId: 'sup-a',
    placedAt: at(placedDay),
    orderedQuantity: '10',
    unit: 'box',
    outcome,
  };
}

function derived(orders: readonly SupplierOrderRecord[], asOf = at(30), override: Partial<PerformancePolicy> = {}) {
  const result = deriveSupplierPerformance('sup-a', orders, { ...policy, ...override }, asOf);
  assert.equal(result.kind, 'derived', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'derived' ? result.performance : (undefined as never);
}

function refusal(orders: readonly SupplierOrderRecord[], asOf = at(30), override: Partial<PerformancePolicy> = {}): string {
  const result = deriveSupplierPerformance('sup-a', orders, { ...policy, ...override }, asOf);
  assert.equal(result.kind, 'refused', result.kind === 'derived' ? 'derived' : '');
  return result.kind === 'refused' ? result.reason : '';
}

describe('supplier fulfilment rate', () => {
  it('measures what arrived against what was ordered', () => {
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      delivered('o-2', 5, 9, '10', '8'),
    ]);

    assert.equal(performance.fulfilmentRate, '0.9');
    assert.equal(performance.completedOrders, 2);
  });

  it('counts a short delivery proportionally rather than as a pass or a fail', () => {
    assert.equal(derived([delivered('o-1', 0, 3, '10', '7'), delivered('o-2', 0, 3, '10', '7')]).fulfilmentRate, '0.7');
  });

  it('counts a supplier rejection as nothing delivered', () => {
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      withOutcome('o-2', { kind: 'rejected_by_supplier' }),
    ]);
    assert.equal(performance.fulfilmentRate, '0.5');
    assert.equal(performance.completedOrders, 2);
  });
});

describe('what a supplier is not blamed for', () => {
  it('excludes an order whose outcome nobody knows, rather than scoring it', () => {
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      delivered('o-2', 0, 3, '10', '10'),
      withOutcome('o-3', { kind: 'unknown' }),
    ]);

    assert.equal(performance.fulfilmentRate, '1');
    assert.equal(performance.completedOrders, 2);
    assert.equal(performance.excludedUnknownOutcome, 1);
  });

  it('excludes an order the pharmacy cancelled', () => {
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      delivered('o-2', 0, 3, '10', '10'),
      withOutcome('o-3', { kind: 'cancelled_by_pharmacy' }),
    ]);

    assert.equal(performance.fulfilmentRate, '1');
    assert.equal(performance.excludedCancelled, 1);
  });

  it('refuses to publish a rate from too few completed orders', () => {
    assert.equal(refusal([delivered('o-1', 0, 3, '10', '10')]), 'insufficient_sample');
    assert.equal(refusal([withOutcome('o-1', { kind: 'unknown' })]), 'insufficient_sample');
    assert.equal(refusal([]), 'insufficient_sample');
    assert.equal(
      refusal([delivered('o-1', 0, 3, '10', '10'), delivered('o-2', 0, 3, '10', '10')], at(30), {
        minimumCompletedOrders: 5,
      }),
      'insufficient_sample',
    );
  });
});

describe('observed lead time and the orders still in flight', () => {
  it('measures the days from placing an order to receiving it', () => {
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      delivered('o-2', 10, 15, '10', '10'),
    ]);
    assert.equal(performance.observedLeadTimeDays, '4');
  });

  it('knows its lead time is understated when an order has already run longer', () => {
    const performance = derived(
      [
        delivered('o-1', 0, 3, '10', '10'),
        delivered('o-2', 0, 3, '10', '10'),
        withOutcome('o-3', { kind: 'outstanding' }, 20),
      ],
      at(30),
    );

    assert.equal(performance.observedLeadTimeDays, '3');
    assert.equal(performance.outstandingOrders, 1);
    assert.equal(performance.leadTimeUnderstated, true);
  });

  it('does not cry bias when nothing outstanding has run long yet', () => {
    const performance = derived(
      [
        delivered('o-1', 0, 10, '10', '10'),
        delivered('o-2', 0, 10, '10', '10'),
        withOutcome('o-3', { kind: 'outstanding' }, 29),
      ],
      at(30),
    );

    assert.equal(performance.observedLeadTimeDays, '10');
    assert.equal(performance.leadTimeUnderstated, false);
  });
});

describe('what performance derivation refuses', () => {
  it('refuses a timeline that runs backwards', () => {
    assert.equal(
      refusal([delivered('o-1', 5, 2, '10', '10'), delivered('o-2', 0, 3, '10', '10')]),
      'unordered_timeline',
    );
  });

  it('refuses to mix units or read an unusable quantity', () => {
    const mixed: SupplierOrderRecord = { ...delivered('o-2', 0, 3, '10', '10'), unit: 'strip' };
    assert.equal(refusal([delivered('o-1', 0, 3, '10', '10'), mixed]), 'unit_mismatch');
    assert.equal(
      refusal([delivered('o-1', 0, 3, '1,000', '10'), delivered('o-2', 0, 3, '10', '10')]),
      'unreadable_amount',
    );
  });

  it('refuses a policy that would publish noise', () => {
    assert.equal(
      refusal([delivered('o-1', 0, 3, '10', '10'), delivered('o-2', 0, 3, '10', '10')], at(30), {
        minimumCompletedOrders: 0,
      }),
      'invalid_policy',
    );
  });

  it('ignores orders belonging to another supplier', () => {
    const other: SupplierOrderRecord = { ...delivered('o-9', 0, 3, '10', '0'), supplierId: 'sup-b' };
    const performance = derived([
      delivered('o-1', 0, 3, '10', '10'),
      delivered('o-2', 0, 3, '10', '10'),
      other,
    ]);
    assert.equal(performance.fulfilmentRate, '1');
    assert.equal(performance.completedOrders, 2);
  });
});
