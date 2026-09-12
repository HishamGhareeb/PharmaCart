import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allocateAcrossSuppliers, type SupplyAllocationResult } from '../src/allocate-supply.ts';
import type { NeedLine, SupplierOffer, SupplierStanding } from '../src/supply-ranking.ts';

const need: NeedLine = { needId: 'need-1', productId: 'pack-10', quantity: '100', unit: 'box' };

function offer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    offerId: 'offer-a',
    offerVersion: 1,
    supplierId: 'sup-a',
    productId: 'pack-10',
    unit: 'box',
    unitPrice: '10',
    availableQuantity: '60',
    minimumOrderQuantity: '1',
    leadTimeDays: 2,
    sponsored: false,
    termsVersion: 4,
    ...overrides,
  };
}

function rated(supplierId: string): SupplierStanding {
  return {
    supplierId,
    relationshipStatus: 'active',
    acceptedTermsVersion: 4,
    performance: { kind: 'rated', fulfilmentRate: '0.9' },
  };
}

const standings: readonly SupplierStanding[] = [rated('sup-a'), rated('sup-b'), rated('sup-c')];

const threeSuppliers: readonly SupplierOffer[] = [
  offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '10', availableQuantity: '60', leadTimeDays: 2 }),
  offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11', availableQuantity: '50', leadTimeDays: 5 }),
  offer({ offerId: 'o-c', supplierId: 'sup-c', unitPrice: '12', availableQuantity: '30', leadTimeDays: 1 }),
];

function allocation(result: SupplyAllocationResult) {
  assert.equal(result.kind, 'allocated', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'allocated' ? result.allocation : (undefined as never);
}

function split(result: SupplyAllocationResult): readonly (readonly [string, string])[] {
  return allocation(result).lines.map((line) => [line.supplierId, line.quantity] as const);
}

describe('allocating one need across several suppliers', () => {
  it('takes everything from one supplier when one can cover it', () => {
    const result = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '40' },
      threeSuppliers,
      standings,
    ));

    assert.deepEqual(result.lines.map((line) => [line.supplierId, line.quantity]), [['sup-a', '40']]);
    assert.equal(result.complete, true);
    assert.equal(result.unfilled, '0');
  });

  it('fills the need from several suppliers in the order it ranked them', () => {
    const result = allocateAcrossSuppliers(need, threeSuppliers, standings);

    assert.deepEqual(split(result), [['sup-a', '60'], ['sup-b', '40']]);
    assert.equal(allocation(result).allocated, '100');
    assert.equal(allocation(result).complete, true);
  });

  it('never allocates more than was asked for', () => {
    const result = allocation(allocateAcrossSuppliers(need, threeSuppliers, standings));
    const total = result.lines.reduce((sum, line) => sum + Number(line.quantity), 0);

    assert.equal(total, 100);
    assert.equal(result.allocated, '100');
  });

  it('charges each supplier for what it actually supplies', () => {
    const result = allocation(allocateAcrossSuppliers(need, threeSuppliers, standings));

    assert.deepEqual(result.lines.map((line) => line.lineTotal), ['600', '440']);
    assert.equal(result.totalCost, '1040');
  });

  it('computes quantities and costs exactly', () => {
    const result = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '0.3' },
      [
        offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '0.1', availableQuantity: '0.1', minimumOrderQuantity: '0.1' }),
        offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '0.1', availableQuantity: '0.2', minimumOrderQuantity: '0.1' }),
      ],
      standings,
    ));

    assert.deepEqual(split({ kind: 'allocated', allocation: result }), [['sup-a', '0.1'], ['sup-b', '0.2']]);
    assert.equal(result.totalCost, '0.03');
  });
});

describe('a partial fill is reported, never disguised', () => {
  it('says how much it could not find', () => {
    const result = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '200' },
      threeSuppliers,
      standings,
    ));

    assert.equal(result.allocated, '140');
    assert.equal(result.unfilled, '60');
    assert.equal(result.complete, false);
  });

  it('skips a supplier whose share would fall below its own minimum, and says so', () => {
    const result = allocation(allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '10', availableQuantity: '60' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11', availableQuantity: '50', minimumOrderQuantity: '45' }),
    ], standings));

    assert.deepEqual(split({ kind: 'allocated', allocation: result }), [['sup-a', '60']]);
    assert.equal(result.unfilled, '40');
    assert.deepEqual(result.skipped, [
      { offerId: 'o-b', supplierId: 'sup-b', reason: 'remainder_below_minimum' },
    ]);
  });

  it('excludes a supplier that could never take part at all', () => {
    const result = allocation(allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-a', supplierId: 'sup-a' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', minimumOrderQuantity: '150' }),
      offer({ offerId: 'o-c', supplierId: 'sup-c', minimumOrderQuantity: '40', availableQuantity: '30' }),
    ], standings));

    assert.deepEqual(
      result.excluded.map((entry) => [entry.supplierId, entry.reason]),
      [['sup-b', 'below_minimum_order'], ['sup-c', 'below_minimum_order']],
    );
  });

  it('marks the suppliers it never needed to reach', () => {
    const result = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '40' },
      threeSuppliers,
      standings,
    ));

    assert.deepEqual(
      result.skipped.map((entry) => [entry.supplierId, entry.reason]),
      [['sup-b', 'need_already_met'], ['sup-c', 'need_already_met']],
    );
  });
});

describe('a split is only as fast as its slowest supplier', () => {
  it('reports the lead time the pharmacy will actually wait', () => {
    const result = allocation(allocateAcrossSuppliers(need, threeSuppliers, standings));

    assert.deepEqual(result.lines.map((line) => line.leadTimeDays), [2, 5]);
    assert.equal(result.effectiveLeadTimeDays, 5);
  });

  it('lets a lead-time sort buy a faster split at a higher price', () => {
    const byPrice = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '80' }, threeSuppliers, standings, { sortMode: 'price' },
    ));
    const byLeadTime = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '80' }, threeSuppliers, standings, { sortMode: 'lead_time' },
    ));

    assert.equal(byPrice.effectiveLeadTimeDays, 5);
    assert.equal(byLeadTime.effectiveLeadTimeDays, 2);
    assert.equal(Number(byLeadTime.totalCost) > Number(byPrice.totalCost), true);
  });

  it('has no lead time when nothing could be allocated', () => {
    const result = allocation(allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-a', supplierId: 'sup-a', minimumOrderQuantity: '150' }),
    ], standings));

    assert.deepEqual(result.lines, []);
    assert.equal(result.effectiveLeadTimeDays, null);
    assert.equal(result.complete, false);
  });
});

describe('allocation inherits the ranking guarantees', () => {
  it('applies filters before allocating', () => {
    const result = allocation(allocateAcrossSuppliers(need, threeSuppliers, standings, {
      filters: { maxLeadTimeDays: 2 },
    }));

    assert.deepEqual(split({ kind: 'allocated', allocation: result }), [['sup-a', '60'], ['sup-c', '30']]);
    assert.equal(result.filtered[0]?.supplierId, 'sup-b');
  });

  it('produces the same split for any permutation of the offers', () => {
    const expected = split(allocateAcrossSuppliers(need, threeSuppliers, standings));
    assert.deepEqual(split(allocateAcrossSuppliers(need, [...threeSuppliers].reverse(), standings)), expected);
  });

  it('refuses a need it cannot allocate against', () => {
    const result = allocateAcrossSuppliers({ ...need, quantity: '0' }, threeSuppliers, standings);
    assert.equal(result.kind, 'refused');
    assert.equal(result.kind === 'refused' ? result.reason : '', 'invalid_need');
  });

  it('refuses a recommended sort here too', () => {
    const result = allocateAcrossSuppliers(need, threeSuppliers, standings, { sortMode: 'recommended' });
    assert.equal(result.kind === 'refused' ? result.reason : '', 'recommended_sort_undefined');
  });
});
