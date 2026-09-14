import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allocateAcrossSuppliers, type SupplyAllocationResult } from '../src/allocate-supply.ts';
import {
  RANKING_CRITERIA,
  SORT_CRITERIA,
  rankEligibleSupply,
  type NeedLine,
  type SupplierOffer,
  type SupplierStanding,
  type SupplyRankingResult,
} from '../src/supply-ranking.ts';

const need: NeedLine = { needId: 'need-1', productId: 'pack-10', quantity: '100', unit: 'box' };

function offer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    offerId: 'o-a',
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

const standings: readonly SupplierStanding[] = [rated('sup-a'), rated('sup-b')];

function ranking(result: SupplyRankingResult) {
  assert.equal(result.kind, 'ranked', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'ranked' ? result.ranking : (undefined as never);
}

function allocation(result: SupplyAllocationResult) {
  assert.equal(result.kind, 'allocated', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'allocated' ? result.allocation : (undefined as never);
}

function refusal(result: SupplyRankingResult | SupplyAllocationResult): readonly [string, string] {
  assert.equal(result.kind, 'refused', result.kind);
  return result.kind === 'refused' ? [result.reason, result.detail] : (undefined as never);
}

/**
 * The same offer listed twice is one stock figure, not two. A feed that repeats
 * an offer would otherwise have its availability counted once per copy, and the
 * pharmacy would be told a need was filled from stock that does not exist.
 */
describe('an offer repeated in the feed is not stock repeated in the warehouse', () => {
  it('refuses to rank a feed that lists the same offer twice', () => {
    const result = rankEligibleSupply(need, [
      offer({ offerId: 'o-a', availableQuantity: '60' }),
      offer({ offerId: 'o-a', availableQuantity: '60' }),
    ], standings);

    assert.deepEqual(refusal(result), ['duplicate_offer', 'o-a']);
  });

  it('refuses even when the copies disagree, rather than picking one', () => {
    const result = rankEligibleSupply(need, [
      offer({ offerId: 'o-a', unitPrice: '10' }),
      offer({ offerId: 'o-a', unitPrice: '99', offerVersion: 2 }),
    ], standings);

    assert.deepEqual(refusal(result), ['duplicate_offer', 'o-a']);
  });

  it('refuses to allocate a need against stock counted twice', () => {
    const result = allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-a', availableQuantity: '60' }),
      offer({ offerId: 'o-a', availableQuantity: '60' }),
    ], standings);

    assert.deepEqual(refusal(result), ['duplicate_offer', 'o-a']);
  });

  it('names the same duplicate whatever order the copies arrive in', () => {
    const offers = [
      offer({ offerId: 'o-b', supplierId: 'sup-b' }),
      offer({ offerId: 'o-a' }),
      offer({ offerId: 'o-a' }),
    ];

    assert.deepEqual(
      rankEligibleSupply(need, offers, standings),
      rankEligibleSupply(need, [...offers].reverse(), standings),
    );
  });

  it('still ranks distinct offers that merely look alike', () => {
    const result = ranking(rankEligibleSupply(need, [
      offer({ offerId: 'o-a', supplierId: 'sup-a', availableQuantity: '100' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', availableQuantity: '100' }),
    ], standings));

    assert.deepEqual(result.ranked.map((entry) => entry.offerId), ['o-a', 'o-b']);
  });
});

/**
 * A minimum order quantity below zero is not a lenient minimum, it is a
 * malformed one. Read literally it disables the gate it exists to enforce, so
 * the offer is excluded and named rather than quietly treated as having none.
 */
describe('a minimum order quantity below zero is malformed, not lenient', () => {
  it('excludes an offer whose minimum is negative', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ minimumOrderQuantity: '-5' })],
      standings,
    ));

    assert.deepEqual(result.excluded, [
      { offerId: 'o-a', supplierId: 'sup-a', reason: 'invalid_minimum_order' },
    ]);
    assert.deepEqual(result.ranked, []);
  });

  it('keeps excluding a minimum it cannot read exactly', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ minimumOrderQuantity: '1,000' })],
      standings,
    ));

    assert.equal(result.excluded[0]?.reason, 'unreadable_amount');
  });

  it('accepts a minimum of zero, which is a real absence of one', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ minimumOrderQuantity: '0', availableQuantity: '100' })],
      standings,
    ));

    assert.equal(result.ranked.length, 1);
  });

  it('never allocates against a negative minimum', () => {
    const result = allocation(allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-a', minimumOrderQuantity: '-5' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', availableQuantity: '100' }),
    ], standings));

    assert.deepEqual(result.lines.map((line) => line.offerId), ['o-b']);
    assert.deepEqual(result.excluded, [
      { offerId: 'o-a', supplierId: 'sup-a', reason: 'invalid_minimum_order' },
    ]);
  });
});

/**
 * Standings are a lookup keyed by supplier, and a list holding two entries for
 * one supplier has no single meaning. Taking the last silently let the order of
 * the list decide whether a revoked supplier could sell.
 */
describe('two standings for one supplier have no single meaning', () => {
  const conflicting: readonly SupplierStanding[] = [
    rated('sup-a'),
    { ...rated('sup-a'), relationshipStatus: 'revoked' },
  ];

  it('refuses rather than letting list order decide', () => {
    assert.deepEqual(
      refusal(rankEligibleSupply(need, [offer()], conflicting)),
      ['duplicate_supplier_standing', 'sup-a'],
    );
  });

  it('answers the same way whichever standing is listed last', () => {
    assert.deepEqual(
      rankEligibleSupply(need, [offer()], conflicting),
      rankEligibleSupply(need, [offer()], [...conflicting].reverse()),
    );
  });

  it('refuses to allocate against an ambiguous standing', () => {
    assert.deepEqual(
      refusal(allocateAcrossSuppliers(need, [offer()], conflicting)),
      ['duplicate_supplier_standing', 'sup-a'],
    );
  });

  it('refuses a repeat even where the two entries agree', () => {
    assert.equal(
      refusal(rankEligibleSupply(need, [offer()], [rated('sup-a'), rated('sup-a')]))[0],
      'duplicate_supplier_standing',
    );
  });

  it('ranks normally when each supplier appears once', () => {
    const result = ranking(rankEligibleSupply(need, [offer({ availableQuantity: '100' })], standings));
    assert.equal(result.ranked.length, 1);
  });
});

/**
 * Supplier identity cannot separate two offers from one supplier, so without a
 * final identity tiebreak their order was whatever the feed happened to emit.
 */
describe('offers tied to the last criterion are ordered by offer identity', () => {
  const twins: readonly SupplierOffer[] = [
    offer({ offerId: 'o-2', availableQuantity: '100' }),
    offer({ offerId: 'o-1', availableQuantity: '100' }),
  ];

  it('orders two offers from one supplier deterministically', () => {
    assert.deepEqual(
      ranking(rankEligibleSupply(need, twins, standings)).ranked.map((entry) => entry.offerId),
      ['o-1', 'o-2'],
    );
  });

  it('produces that same order for the opposite feed order', () => {
    assert.deepEqual(
      ranking(rankEligibleSupply(need, [...twins].reverse(), standings)).ranked
        .map((entry) => entry.offerId),
      ['o-1', 'o-2'],
    );
  });

  it('declares offer identity as the terminal criterion of every sort', () => {
    assert.deepEqual(
      [...RANKING_CRITERIA],
      ['line_total', 'lead_time_days', 'fulfilment_rate', 'supplier_id', 'offer_id'],
    );
    for (const [mode, criteria] of Object.entries(SORT_CRITERIA)) {
      assert.equal(criteria.at(-1), 'offer_id', mode);
      assert.equal(criteria.at(-2), 'supplier_id', mode);
    }
  });

  it('names offer identity when that is all that separates an offer from the leader', () => {
    const result = ranking(rankEligibleSupply(need, twins, standings));
    assert.equal(result.ranked[0]?.differsFromLeaderAt, null);
    assert.equal(result.ranked[1]?.differsFromLeaderAt, 'offer_id');
  });
});

/**
 * Two offers from one supplier for one product may be two pools or one pool
 * described twice. Nothing in the feed says which, so adding their stock
 * together is a guess, and the allocator refuses instead of making it.
 */
describe('stock from one supplier cannot be added to itself', () => {
  const twoPools: readonly SupplierOffer[] = [
    offer({ offerId: 'o-1', supplierId: 'sup-a', availableQuantity: '60', unitPrice: '10' }),
    offer({ offerId: 'o-2', supplierId: 'sup-a', availableQuantity: '60', unitPrice: '11' }),
  ];

  it('refuses when filling the need would draw on one supplier twice', () => {
    assert.deepEqual(
      refusal(allocateAcrossSuppliers(need, twoPools, standings)),
      ['ambiguous_supplier_stock', 'sup-a'],
    );
  });

  it('allocates normally when one of the two offers is enough', () => {
    const result = allocation(allocateAcrossSuppliers(
      { ...need, quantity: '40' },
      twoPools,
      standings,
    ));

    assert.deepEqual(result.lines.map((line) => [line.offerId, line.quantity]), [['o-1', '40']]);
    assert.equal(result.complete, true);
  });

  it('refuses rather than short-filling from the first offer alone', () => {
    const result = allocateAcrossSuppliers({ ...need, quantity: '90' }, twoPools, standings);
    assert.equal(refusal(result)[0], 'ambiguous_supplier_stock');
  });

  it('still splits across offers held by different suppliers', () => {
    const result = allocation(allocateAcrossSuppliers(need, [
      offer({ offerId: 'o-1', supplierId: 'sup-a', availableQuantity: '60', unitPrice: '10' }),
      offer({ offerId: 'o-2', supplierId: 'sup-b', availableQuantity: '60', unitPrice: '11' }),
    ], standings));

    assert.deepEqual(
      result.lines.map((line) => [line.supplierId, line.quantity]),
      [['sup-a', '60'], ['sup-b', '40']],
    );
  });

  it('refuses the same way whatever order the two pools arrive in', () => {
    assert.deepEqual(
      allocateAcrossSuppliers(need, twoPools, standings),
      allocateAcrossSuppliers(need, [...twoPools].reverse(), standings),
    );
  });
});
