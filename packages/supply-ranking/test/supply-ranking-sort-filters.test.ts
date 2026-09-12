import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  rankEligibleSupply,
  SORT_CRITERIA,
  type NeedLine,
  type RankingOptions,
  type SupplierOffer,
  type SupplierStanding,
  type SupplyRankingResult,
} from '../src/supply-ranking.ts';

const need: NeedLine = { needId: 'need-1', productId: 'pack-10', quantity: '10', unit: 'box' };

function offer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    offerId: 'offer-a',
    offerVersion: 1,
    supplierId: 'sup-a',
    productId: 'pack-10',
    unit: 'box',
    unitPrice: '12.50',
    availableQuantity: '100',
    minimumOrderQuantity: '1',
    leadTimeDays: 2,
    sponsored: false,
    termsVersion: 4,
    ...overrides,
  };
}

function rated(supplierId: string, fulfilmentRate: string): SupplierStanding {
  return {
    supplierId,
    relationshipStatus: 'active',
    acceptedTermsVersion: 4,
    performance: { kind: 'rated', fulfilmentRate },
  };
}

function unrated(supplierId: string): SupplierStanding {
  return { supplierId, relationshipStatus: 'active', acceptedTermsVersion: 4, performance: { kind: 'unrated' } };
}

function ranking(result: SupplyRankingResult) {
  assert.equal(result.kind, 'ranked', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'ranked' ? result.ranking : (undefined as never);
}

function refusalOf(result: SupplyRankingResult): string {
  assert.equal(result.kind, 'refused', result.kind);
  return result.kind === 'refused' ? result.reason : '';
}

const threeOffers: readonly SupplierOffer[] = [
  offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '12', leadTimeDays: 1, availableQuantity: '50' }),
  offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11', leadTimeDays: 7, availableQuantity: '200' }),
  offer({ offerId: 'o-c', supplierId: 'sup-c', unitPrice: '13', leadTimeDays: 3, availableQuantity: '100' }),
];

const allRated: readonly SupplierStanding[] = [
  rated('sup-a', '0.70'), rated('sup-b', '0.90'), rated('sup-c', '0.80'),
];

function orderUnder(options: RankingOptions, standings = allRated): readonly string[] {
  return ranking(rankEligibleSupply(need, threeOffers, standings, options)).ranked
    .map((entry) => entry.supplierId);
}

describe('the pharmacy chooses how supply is sorted', () => {
  it('defaults to price, which is what it did before sort modes existed', () => {
    assert.deepEqual(orderUnder({}), ['sup-b', 'sup-a', 'sup-c']);
    assert.deepEqual(orderUnder({ sortMode: 'price' }), orderUnder({}));
  });

  it('sorts by how soon it can arrive', () => {
    assert.deepEqual(orderUnder({ sortMode: 'lead_time' }), ['sup-a', 'sup-c', 'sup-b']);
  });

  it('sorts by headroom above what is needed', () => {
    assert.deepEqual(orderUnder({ sortMode: 'available_quantity' }), ['sup-b', 'sup-c', 'sup-a']);
  });

  it('sorts by rating when every eligible supplier has one', () => {
    assert.deepEqual(orderUnder({ sortMode: 'rating' }), ['sup-b', 'sup-c', 'sup-a']);
  });

  it('declares the precedence each mode uses', () => {
    assert.deepEqual([...SORT_CRITERIA.price], ['line_total', 'lead_time_days', 'fulfilment_rate', 'supplier_id']);
    assert.equal(SORT_CRITERIA.lead_time[0], 'lead_time_days');
    assert.equal(SORT_CRITERIA.rating[0], 'fulfilment_rate');
    assert.equal(SORT_CRITERIA.available_quantity[0], 'available_quantity');
  });

  it('reports the mode it actually used', () => {
    const result = ranking(rankEligibleSupply(need, threeOffers, allRated, { sortMode: 'lead_time' }));
    assert.equal(result.sortMode, 'lead_time');
  });

  it('keeps every mode stable under permutation of the offers', () => {
    for (const sortMode of ['price', 'lead_time', 'rating', 'available_quantity'] as const) {
      const expected = orderUnder({ sortMode });
      const reversed = ranking(
        rankEligibleSupply(need, [...threeOffers].reverse(), allRated, { sortMode }),
      ).ranked.map((entry) => entry.supplierId);
      assert.deepEqual(reversed, expected, sortMode);
    }
  });
});

describe('sorting by rating needs every supplier to have one', () => {
  it('refuses when any eligible supplier is unrated', () => {
    const standings = [rated('sup-a', '0.70'), unrated('sup-b'), rated('sup-c', '0.80')];
    assert.equal(
      refusalOf(rankEligibleSupply(need, threeOffers, standings, { sortMode: 'rating' })),
      'mixed_rating_comparison',
    );
  });

  it('still sorts by price with unrated suppliers present, because rate is never reached', () => {
    const standings = [rated('sup-a', '0.70'), unrated('sup-b'), rated('sup-c', '0.80')];
    assert.deepEqual(orderUnder({ sortMode: 'price' }, standings), ['sup-b', 'sup-a', 'sup-c']);
  });

  it('refuses a recommended sort rather than inventing its weights', () => {
    assert.equal(
      refusalOf(rankEligibleSupply(need, threeOffers, allRated, { sortMode: 'recommended' })),
      'recommended_sort_undefined',
    );
  });
});

describe('filters narrow the field without pretending offers were ineligible', () => {
  it('drops offers that arrive too late', () => {
    const result = ranking(rankEligibleSupply(need, threeOffers, allRated, {
      filters: { maxLeadTimeDays: 3 },
    }));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-a', 'sup-c']);
    assert.deepEqual(result.filtered, [{ offerId: 'o-b', supplierId: 'sup-b', reason: 'filtered_lead_time' }]);
    assert.deepEqual(result.excluded, []);
  });

  it('drops offers above a price ceiling', () => {
    const result = ranking(rankEligibleSupply(need, threeOffers, allRated, {
      filters: { maxUnitPrice: '12' },
    }));
    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-b', 'sup-a']);
    assert.equal(result.filtered[0]?.reason, 'filtered_price');
  });

  it('drops offers without enough headroom', () => {
    const result = ranking(rankEligibleSupply(need, threeOffers, allRated, {
      filters: { minAvailableQuantity: '100' },
    }));
    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-b', 'sup-c']);
    assert.equal(result.filtered[0]?.reason, 'filtered_available_quantity');
  });

  it('drops suppliers below a rating floor, and unrated ones with them', () => {
    const standings = [rated('sup-a', '0.70'), unrated('sup-b'), rated('sup-c', '0.80')];
    const result = ranking(rankEligibleSupply(need, threeOffers, standings, {
      filters: { minFulfilmentRate: '0.75' },
    }));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-c']);
    assert.deepEqual(
      result.filtered.map((entry) => entry.supplierId).sort(),
      ['sup-a', 'sup-b'],
    );
  });

  it('can exclude sponsored offers outright', () => {
    const offers = [
      offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '11', sponsored: true }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '12' }),
    ];
    const result = ranking(rankEligibleSupply(need, offers, allRated, {
      filters: { excludeSponsored: true },
    }));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-b']);
    assert.equal(result.filtered[0]?.reason, 'filtered_sponsored');
    assert.equal(result.sponsoredCount, 0);
  });

  it('reports an offer that was never eligible as ineligible, not as filtered', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ offerId: 'o-a', supplierId: 'sup-a', unit: 'strip', leadTimeDays: 99 })],
      allRated,
      { filters: { maxLeadTimeDays: 3 } },
    ));

    assert.deepEqual(result.filtered, []);
    assert.equal(result.excluded[0]?.reason, 'unit_mismatch');
  });

  it('discloses the filters it applied', () => {
    const result = ranking(rankEligibleSupply(need, threeOffers, allRated, {
      filters: { maxLeadTimeDays: 3, excludeSponsored: true },
    }));
    assert.deepEqual(result.filters, { maxLeadTimeDays: 3, excludeSponsored: true });
  });

  it('refuses a filter threshold it cannot read', () => {
    for (const filters of [{ maxUnitPrice: '1,000' }, { minFulfilmentRate: '1.5' }, { minAvailableQuantity: 'lots' }]) {
      assert.equal(
        refusalOf(rankEligibleSupply(need, threeOffers, allRated, { filters })),
        'invalid_filter',
      );
    }
    assert.equal(
      refusalOf(rankEligibleSupply(need, threeOffers, allRated, { filters: { maxLeadTimeDays: -1 } })),
      'invalid_filter',
    );
  });
});
