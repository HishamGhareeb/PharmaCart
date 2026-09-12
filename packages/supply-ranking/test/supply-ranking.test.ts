import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RANKING_CRITERIA,
  rankEligibleSupply,
  type NeedLine,
  type SupplierOffer,
  type SupplierStanding,
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

function standing(overrides: Partial<SupplierStanding> = {}): SupplierStanding {
  return {
    supplierId: 'sup-a',
    relationshipStatus: 'active',
    acceptedTermsVersion: 4,
    fulfilmentRate: '0.95',
    ...overrides,
  };
}

const standings: readonly SupplierStanding[] = [
  standing(),
  standing({ supplierId: 'sup-b' }),
  standing({ supplierId: 'sup-c' }),
];

function rankedIds(offers: readonly SupplierOffer[], view = standings): readonly string[] {
  return rankEligibleSupply(need, offers, view).ranked.map((entry) => entry.supplierId);
}

function exclusionFor(overrides: Partial<SupplierOffer>, view = standings): string {
  const result = rankEligibleSupply(need, [offer(overrides)], view);
  assert.equal(result.ranked.length, 0);
  return result.excluded[0]?.reason ?? '';
}

describe('neutral supply ranking', () => {
  it('orders eligible offers by what the pharmacy actually pays', () => {
    const order = rankedIds([
      offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '12.50' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11.00' }),
      offer({ offerId: 'o-c', supplierId: 'sup-c', unitPrice: '13.25' }),
    ]);
    assert.deepEqual(order, ['sup-b', 'sup-a', 'sup-c']);
  });

  it('computes the line total exactly rather than through a float', () => {
    const result = rankEligibleSupply(
      { ...need, quantity: '3' },
      [offer({ unitPrice: '0.1' })],
      standings,
    );
    assert.equal(result.ranked[0]?.lineTotal, '0.3');
  });

  it('never lets sponsorship change merit order', () => {
    const plain = [
      offer({ offerId: 'o-a', supplierId: 'sup-a' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b' }),
    ];
    const aSponsored = [
      offer({ offerId: 'o-a', supplierId: 'sup-a', sponsored: true }),
      offer({ offerId: 'o-b', supplierId: 'sup-b' }),
    ];
    const bSponsored = [
      offer({ offerId: 'o-a', supplierId: 'sup-a' }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', sponsored: true }),
    ];

    assert.deepEqual(rankedIds(aSponsored), rankedIds(plain));
    assert.deepEqual(rankedIds(bSponsored), rankedIds(plain));
  });

  it('keeps a sponsored offer below a cheaper one', () => {
    const order = rankedIds([
      offer({ offerId: 'o-a', supplierId: 'sup-a', unitPrice: '15.00', sponsored: true }),
      offer({ offerId: 'o-b', supplierId: 'sup-b', unitPrice: '11.00' }),
    ]);
    assert.deepEqual(order, ['sup-b', 'sup-a']);
  });

  it('discloses sponsorship on the offer and in the summary', () => {
    const result = rankEligibleSupply(
      need,
      [
        offer({ offerId: 'o-a', supplierId: 'sup-a', sponsored: true }),
        offer({ offerId: 'o-b', supplierId: 'sup-b' }),
      ],
      standings,
    );
    assert.equal(result.sponsoredCount, 1);
    assert.equal(result.ranked.find((entry) => entry.supplierId === 'sup-a')?.sponsored, true);
    assert.equal(result.ranked.find((entry) => entry.supplierId === 'sup-b')?.sponsored, false);
  });

  it('breaks ties by lead time, then fulfilment, then supplier identity', () => {
    assert.deepEqual(
      rankedIds([
        offer({ supplierId: 'sup-a', leadTimeDays: 5 }),
        offer({ supplierId: 'sup-b', leadTimeDays: 1 }),
      ]),
      ['sup-b', 'sup-a'],
    );

    assert.deepEqual(
      rankedIds(
        [offer({ supplierId: 'sup-a' }), offer({ supplierId: 'sup-b' })],
        [standing({ fulfilmentRate: '0.80' }), standing({ supplierId: 'sup-b', fulfilmentRate: '0.99' })],
      ),
      ['sup-b', 'sup-a'],
    );

    assert.deepEqual(
      rankedIds([offer({ supplierId: 'sup-c' }), offer({ supplierId: 'sup-a' })]),
      ['sup-a', 'sup-c'],
    );
  });

  it('names the first criterion where each offer parts from the leader', () => {
    const result = rankEligibleSupply(
      need,
      [
        offer({ supplierId: 'sup-a', unitPrice: '11.00' }),
        offer({ supplierId: 'sup-b', unitPrice: '12.00' }),
        offer({ supplierId: 'sup-c', unitPrice: '11.00', leadTimeDays: 9 }),
      ],
      standings,
    );

    const by = (id: string): string | null =>
      result.ranked.find((entry) => entry.supplierId === id)?.differsFromLeaderAt ?? null;

    assert.equal(by('sup-a'), null);
    assert.equal(by('sup-c'), 'lead_time_days');
    assert.equal(by('sup-b'), 'line_total');
    assert.deepEqual([...RANKING_CRITERIA], ['line_total', 'lead_time_days', 'fulfilment_rate', 'supplier_id']);
  });
});

describe('supply eligibility gates', () => {
  it('excludes an offer whose supplier relationship is not active', () => {
    assert.equal(
      exclusionFor({}, [standing({ relationshipStatus: 'suspended' })]),
      'relationship_inactive',
    );
    assert.equal(exclusionFor({}, []), 'no_supplier_standing');
  });

  it('excludes an offer on terms the pharmacy has not accepted', () => {
    assert.equal(exclusionFor({ termsVersion: 5 }), 'terms_not_accepted');
  });

  it('excludes an offer for another product or another unit', () => {
    assert.equal(exclusionFor({ productId: 'pack-20' }), 'product_mismatch');
    assert.equal(exclusionFor({ unit: 'strip' }), 'unit_mismatch');
  });

  it('excludes an offer that cannot cover the need', () => {
    assert.equal(exclusionFor({ availableQuantity: '9' }), 'insufficient_stock');
    assert.equal(exclusionFor({ minimumOrderQuantity: '11' }), 'below_minimum_order');
  });

  it('excludes an offer carrying a price it cannot read exactly', () => {
    assert.equal(exclusionFor({ unitPrice: '1,250' }), 'unreadable_amount');
    assert.equal(exclusionFor({ availableQuantity: '1e3' }), 'unreadable_amount');
  });

  it('returns an empty ranking rather than a fallback when nothing qualifies', () => {
    const result = rankEligibleSupply(need, [offer({ unit: 'strip' })], standings);
    assert.deepEqual(result.ranked, []);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.sponsoredCount, 0);
  });
});
