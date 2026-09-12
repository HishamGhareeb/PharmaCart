import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  rankEligibleSupply,
  type NeedLine,
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
  return {
    supplierId,
    relationshipStatus: 'active',
    acceptedTermsVersion: 4,
    performance: { kind: 'unrated' },
  };
}

function ranking(result: SupplyRankingResult) {
  assert.equal(result.kind, 'ranked', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'ranked' ? result.ranking : (undefined as never);
}

function refusalOf(result: SupplyRankingResult): string {
  assert.equal(result.kind, 'refused', result.kind);
  return result.kind === 'refused' ? result.reason : '';
}

describe('ranking represents unrated suppliers honestly', () => {
  it('never manufactures a rate for a supplier that has none', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-a', unitPrice: '11' }), offer({ supplierId: 'sup-b', unitPrice: '12' })],
      [unrated('sup-a'), unrated('sup-b')],
    ));

    assert.deepEqual(result.ranked.map((entry) => entry.performance), [
      { kind: 'unrated' },
      { kind: 'unrated' },
    ]);
    assert.equal(result.unratedCount, 2);
  });

  it('carries a rated supplier rate through to the output', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-a' })],
      [rated('sup-a', '0.95')],
    ));

    assert.deepEqual(result.ranked[0]?.performance, { kind: 'rated', fulfilmentRate: '0.95' });
    assert.equal(result.unratedCount, 0);
  });

  it('orders unrated suppliers among themselves by the deterministic tiebreaker', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-c' }), offer({ supplierId: 'sup-a' })],
      [unrated('sup-a'), unrated('sup-c')],
    ));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-a', 'sup-c']);
  });
});

describe('mixed rated and unrated comparison is refused, not guessed', () => {
  it('refuses when a rated and an unrated offer tie on price and lead time', () => {
    const result = rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-a' }), offer({ supplierId: 'sup-b' })],
      [rated('sup-a', '0.9'), unrated('sup-b')],
    );

    assert.equal(refusalOf(result), 'mixed_rating_comparison');
  });

  it('ranks normally when price separates a rated from an unrated supplier', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-a', unitPrice: '15' }), offer({ supplierId: 'sup-b', unitPrice: '11' })],
      [rated('sup-a', '0.9'), unrated('sup-b')],
    ));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-b', 'sup-a']);
  });

  it('ranks normally when lead time separates them', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ supplierId: 'sup-a', leadTimeDays: 9 }), offer({ supplierId: 'sup-b', leadTimeDays: 1 })],
      [rated('sup-a', '0.9'), unrated('sup-b')],
    ));

    assert.deepEqual(result.ranked.map((entry) => entry.supplierId), ['sup-b', 'sup-a']);
  });

  it('refuses the same way whatever order the offers arrive in', () => {
    const offers = [offer({ supplierId: 'sup-a' }), offer({ supplierId: 'sup-b' })];
    const standings = [rated('sup-a', '0.9'), unrated('sup-b')];

    assert.deepEqual(
      rankEligibleSupply(need, offers, standings),
      rankEligibleSupply(need, [...offers].reverse(), [...standings].reverse()),
    );
  });
});

describe('ranking is stable under permutation', () => {
  const offers: readonly SupplierOffer[] = [
    offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '11' }),
    offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11' }),
    offer({ offerId: 'o-c', supplierId: 'sup-c', unitPrice: '12' }),
    offer({ offerId: 'o-d', supplierId: 'sup-d', unitPrice: '11', leadTimeDays: 5 }),
  ];
  const standings: readonly SupplierStanding[] = [
    rated('sup-a', '0.80'), rated('sup-b', '0.99'), rated('sup-c', '0.50'), rated('sup-d', '0.99'),
  ];

  it('produces one order for every permutation of the offers', () => {
    const expected = ranking(rankEligibleSupply(need, offers, standings)).ranked
      .map((entry) => entry.supplierId);

    const permutations = [
      [...offers].reverse(),
      [offers[2]!, offers[0]!, offers[3]!, offers[1]!],
      [offers[1]!, offers[3]!, offers[2]!, offers[0]!],
    ];
    for (const permutation of permutations) {
      const actual = ranking(rankEligibleSupply(need, permutation, standings)).ranked
        .map((entry) => entry.supplierId);
      assert.deepEqual(actual, expected);
    }
    assert.deepEqual(expected, ['sup-b', 'sup-a', 'sup-d', 'sup-c']);
  });
});

describe('ranking validates what it is given', () => {
  it('refuses a need it cannot buy against', () => {
    for (const quantity of ['0', '-5', '1,000', '']) {
      assert.equal(
        refusalOf(rankEligibleSupply({ ...need, quantity }, [offer()], [rated('sup-a', '0.9')])),
        'invalid_need',
      );
    }
  });

  it('excludes an offer priced below nothing', () => {
    const result = ranking(rankEligibleSupply(
      need,
      [offer({ unitPrice: '-1' })],
      [rated('sup-a', '0.9')],
    ));
    assert.equal(result.excluded[0]?.reason, 'negative_price');
  });

  it('excludes an offer with a lead time that is not a real number of days', () => {
    for (const leadTimeDays of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = ranking(rankEligibleSupply(
        need,
        [offer({ leadTimeDays })],
        [rated('sup-a', '0.9')],
      ));
      assert.equal(result.excluded[0]?.reason, 'invalid_lead_time', String(leadTimeDays));
    }
  });

  it('excludes a supplier whose rate is not a proportion', () => {
    for (const rate of ['1.5', '-0.1', 'most of the time']) {
      const result = ranking(rankEligibleSupply(need, [offer()], [rated('sup-a', rate)]));
      assert.equal(result.excluded[0]?.reason, 'invalid_rating', rate);
    }
  });

  it('accepts the boundaries of a proportion', () => {
    for (const rate of ['0', '1', '0.0001']) {
      const result = ranking(rankEligibleSupply(need, [offer()], [rated('sup-a', rate)]));
      assert.equal(result.ranked.length, 1, rate);
    }
  });
});
