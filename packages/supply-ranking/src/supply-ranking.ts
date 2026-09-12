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

/**
 * Unrated is a state, not a number. A supplier with too few completed orders
 * has no fulfilment rate, and substituting one would either put an unmeasured
 * supplier at the top of a merit ranking or bury it permanently.
 */
export type SupplierPerformanceRating =
  | Readonly<{ kind: 'rated'; fulfilmentRate: string }>
  | Readonly<{ kind: 'unrated' }>;

export type SupplierStanding = Readonly<{
  supplierId: string;
  relationshipStatus: 'active' | 'suspended' | 'revoked';
  acceptedTermsVersion: number;
  performance: SupplierPerformanceRating;
}>;

export type ExclusionReason =
  | 'no_supplier_standing'
  | 'relationship_inactive'
  | 'terms_not_accepted'
  | 'invalid_rating'
  | 'product_mismatch'
  | 'unit_mismatch'
  | 'negative_price'
  | 'invalid_lead_time'
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
  performance: SupplierPerformanceRating;
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
  unratedCount: number;
}>;

export type RankingRefusalReason = 'invalid_need' | 'mixed_rating_comparison';

export type SupplyRankingResult =
  | Readonly<{ kind: 'ranked'; ranking: SupplyRanking }>
  | Readonly<{ kind: 'refused'; reason: RankingRefusalReason; detail: string }>;

type EligibleOffer = Readonly<{
  offer: SupplierOffer;
  lineTotal: string;
  performance: SupplierPerformanceRating;
}>;

/**
 * Sponsorship is carried through to the result as a disclosure and takes no
 * part in the ordering. A ranking that let a paid placement outrank a cheaper
 * or faster offer would not be neutral, whatever it was called, so the sort
 * reads only the criteria in RANKING_CRITERIA.
 *
 * Comparing a rated supplier against an unrated one is refused rather than
 * resolved. Falling back to the identity tiebreaker for mixed pairs produces a
 * comparator with cycles: given three offers tied on price and lead time where
 * A is rated 0.5, B is unrated and C is rated 0.9, identity puts A before B and
 * B before C while rate puts C before A. A sort built on that is
 * order-dependent and silently wrong, so the mixed case is named and refused
 * until the ranking policy for unrated suppliers is decided.
 */
export function rankEligibleSupply(
  need: NeedLine,
  offers: readonly SupplierOffer[],
  standings: readonly SupplierStanding[],
): SupplyRankingResult {
  const needQuantitySign = compareDecimals(need.quantity, '0');
  if (needQuantitySign === undefined || needQuantitySign <= 0) {
    return { kind: 'refused', reason: 'invalid_need', detail: need.needId };
  }

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

  const mixedGroup = firstMixedRatingGroup(eligible);
  if (mixedGroup !== undefined) {
    return { kind: 'refused', reason: 'mixed_rating_comparison', detail: mixedGroup };
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
    performance: entry.performance,
    sponsored: entry.offer.sponsored,
    differsFromLeaderAt: leader === undefined ? null : firstDifference(leader, entry),
  }));

  return {
    kind: 'ranked',
    ranking: Object.freeze({
      needId: need.needId,
      criteria: RANKING_CRITERIA,
      ranked: Object.freeze(ranked),
      excluded: Object.freeze(excluded),
      sponsoredCount: ranked.filter((entry) => entry.sponsored).length,
      unratedCount: ranked.filter((entry) => entry.performance.kind === 'unrated').length,
    }),
  };
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
  if (!validRating(standing.performance)) {
    return 'invalid_rating';
  }
  if (offer.productId !== need.productId) {
    return 'product_mismatch';
  }
  if (offer.unit !== need.unit) {
    return 'unit_mismatch';
  }

  const priceSign = compareDecimals(offer.unitPrice, '0');
  if (priceSign === undefined) {
    return 'unreadable_amount';
  }
  if (priceSign < 0) {
    return 'negative_price';
  }
  if (!Number.isSafeInteger(offer.leadTimeDays) || offer.leadTimeDays < 0) {
    return 'invalid_lead_time';
  }

  const lineTotal = multiplyDecimals(offer.unitPrice, need.quantity);
  const stockOrder = compareDecimals(offer.availableQuantity, need.quantity);
  const minimumOrder = compareDecimals(need.quantity, offer.minimumOrderQuantity);
  if (lineTotal === undefined || stockOrder === undefined || minimumOrder === undefined) {
    return 'unreadable_amount';
  }
  if (stockOrder < 0) {
    return 'insufficient_stock';
  }
  if (minimumOrder < 0) {
    return 'below_minimum_order';
  }

  return { offer, lineTotal, performance: standing.performance };
}

function validRating(performance: SupplierPerformanceRating): boolean {
  if (performance.kind === 'unrated') {
    return true;
  }
  const lower = compareDecimals(performance.fulfilmentRate, '0');
  const upper = compareDecimals(performance.fulfilmentRate, '1');
  return lower !== undefined && upper !== undefined && lower >= 0 && upper <= 0;
}

function firstMixedRatingGroup(eligible: readonly EligibleOffer[]): string | undefined {
  const groups = new Map<string, { rated: boolean; unrated: boolean }>();
  for (const entry of eligible) {
    const key = `${entry.lineTotal}@${entry.offer.leadTimeDays}`;
    const seen = groups.get(key) ?? { rated: false, unrated: false };
    if (entry.performance.kind === 'rated') {
      seen.rated = true;
    } else {
      seen.unrated = true;
    }
    groups.set(key, seen);
  }

  return [...groups.entries()]
    .filter(([, seen]) => seen.rated && seen.unrated)
    .map(([key]) => key)
    .sort()[0];
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
    if (left.performance.kind !== 'rated' || right.performance.kind !== 'rated') {
      return 0;
    }
    return compareDecimals(right.performance.fulfilmentRate, left.performance.fulfilmentRate) ?? 0;
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
