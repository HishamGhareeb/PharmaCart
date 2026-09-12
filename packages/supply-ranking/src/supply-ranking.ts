import { compareDecimals, multiplyDecimals } from '../../exact-decimal/src/exact-decimal.ts';

export const RANKING_CRITERIA = [
  'line_total',
  'lead_time_days',
  'fulfilment_rate',
  'supplier_id',
] as const;

export type RankingCriterion = (typeof RANKING_CRITERIA)[number];

export type NeedLine = Readonly<{
  needId: string;
  productId: string;
  quantity: string;
  unit: string;
}>;

export type SupplierOffer = Readonly<{
  offerId: string;
  offerVersion: number;
  supplierId: string;
  productId: string;
  unit: string;
  unitPrice: string;
  availableQuantity: string;
  minimumOrderQuantity: string;
  leadTimeDays: number;
  sponsored: boolean;
  termsVersion: number;
}>;

export type SupplierStanding = Readonly<{
  supplierId: string;
  relationshipStatus: 'active' | 'suspended' | 'revoked';
  acceptedTermsVersion: number;
  fulfilmentRate: string;
}>;

export type ExclusionReason =
  | 'no_supplier_standing'
  | 'relationship_inactive'
  | 'terms_not_accepted'
  | 'product_mismatch'
  | 'unit_mismatch'
  | 'unreadable_amount'
  | 'insufficient_stock'
  | 'below_minimum_order';

export type RankedOffer = Readonly<{
  offerId: string;
  supplierId: string;
  rank: number;
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number;
  fulfilmentRate: string;
  sponsored: boolean;
  differsFromLeaderAt: RankingCriterion | null;
}>;

export type ExcludedOffer = Readonly<{
  offerId: string;
  supplierId: string;
  reason: ExclusionReason;
}>;

export type SupplyRanking = Readonly<{
  needId: string;
  criteria: readonly RankingCriterion[];
  ranked: readonly RankedOffer[];
  excluded: readonly ExcludedOffer[];
  sponsoredCount: number;
}>;

type EligibleOffer = Readonly<{
  offer: SupplierOffer;
  lineTotal: string;
  fulfilmentRate: string;
}>;

/**
 * Sponsorship is carried through to the result as a disclosure and takes no
 * part in the ordering. A ranking that let a paid placement outrank a cheaper
 * or faster offer would not be neutral, whatever it was called, so the sort
 * reads only the criteria in RANKING_CRITERIA.
 */
export function rankEligibleSupply(
  need: NeedLine,
  offers: readonly SupplierOffer[],
  standings: readonly SupplierStanding[],
): SupplyRanking {
  const standingBySupplier = new Map(standings.map((entry) => [entry.supplierId, entry]));
  const eligible: EligibleOffer[] = [];
  const excluded: ExcludedOffer[] = [];

  for (const offer of offers) {
    const assessed = assessOffer(need, offer, standingBySupplier.get(offer.supplierId));
    if (typeof assessed === 'string') {
      excluded.push({ offerId: offer.offerId, supplierId: offer.supplierId, reason: assessed });
      continue;
    }
    eligible.push(assessed);
  }

  eligible.sort(compareEligibleOffers);

  const leader = eligible[0];
  const ranked = eligible.map((entry, index) => Object.freeze({
    offerId: entry.offer.offerId,
    supplierId: entry.offer.supplierId,
    rank: index + 1,
    unitPrice: entry.offer.unitPrice,
    lineTotal: entry.lineTotal,
    leadTimeDays: entry.offer.leadTimeDays,
    fulfilmentRate: entry.fulfilmentRate,
    sponsored: entry.offer.sponsored,
    differsFromLeaderAt: leader === undefined ? null : firstDifference(leader, entry),
  }));

  return Object.freeze({
    needId: need.needId,
    criteria: RANKING_CRITERIA,
    ranked: Object.freeze(ranked),
    excluded: Object.freeze(excluded),
    sponsoredCount: ranked.filter((entry) => entry.sponsored).length,
  });
}

function assessOffer(
  need: NeedLine,
  offer: SupplierOffer,
  standing: SupplierStanding | undefined,
): EligibleOffer | ExclusionReason {
  if (standing === undefined) {
    return 'no_supplier_standing';
  }
  if (standing.relationshipStatus !== 'active') {
    return 'relationship_inactive';
  }
  if (offer.termsVersion > standing.acceptedTermsVersion) {
    return 'terms_not_accepted';
  }
  if (offer.productId !== need.productId) {
    return 'product_mismatch';
  }
  if (offer.unit !== need.unit) {
    return 'unit_mismatch';
  }

  const lineTotal = multiplyDecimals(offer.unitPrice, need.quantity);
  const stockOrder = compareDecimals(offer.availableQuantity, need.quantity);
  const minimumOrder = compareDecimals(need.quantity, offer.minimumOrderQuantity);
  const fulfilmentReadable = compareDecimals(standing.fulfilmentRate, '0');
  if (
    lineTotal === undefined
    || stockOrder === undefined
    || minimumOrder === undefined
    || fulfilmentReadable === undefined
  ) {
    return 'unreadable_amount';
  }

  if (stockOrder < 0) {
    return 'insufficient_stock';
  }
  if (minimumOrder < 0) {
    return 'below_minimum_order';
  }

  return { offer, lineTotal, fulfilmentRate: standing.fulfilmentRate };
}

function compareEligibleOffers(left: EligibleOffer, right: EligibleOffer): number {
  for (const criterion of RANKING_CRITERIA) {
    const order = compareCriterion(criterion, left, right);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

function compareCriterion(
  criterion: RankingCriterion,
  left: EligibleOffer,
  right: EligibleOffer,
): number {
  if (criterion === 'line_total') {
    return compareDecimals(left.lineTotal, right.lineTotal) ?? 0;
  }
  if (criterion === 'lead_time_days') {
    return Math.sign(left.offer.leadTimeDays - right.offer.leadTimeDays);
  }
  if (criterion === 'fulfilment_rate') {
    return compareDecimals(right.fulfilmentRate, left.fulfilmentRate) ?? 0;
  }
  return compareSupplierIds(left.offer.supplierId, right.offer.supplierId);
}

function firstDifference(leader: EligibleOffer, candidate: EligibleOffer): RankingCriterion | null {
  for (const criterion of RANKING_CRITERIA) {
    if (compareCriterion(criterion, leader, candidate) !== 0) {
      return criterion;
    }
  }
  return null;
}

function compareSupplierIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
