import { compareDecimals, multiplyDecimals } from '../../exact-decimal/src/exact-decimal.ts';

export const RANKING_CRITERIA = [
  'line_total',
  'lead_time_days',
  'fulfilment_rate',
  'supplier_id',
] as const;

export type RankingCriterion =
  | (typeof RANKING_CRITERIA)[number]
  | 'available_quantity';

export type SortMode = 'price' | 'lead_time' | 'rating' | 'available_quantity' | 'recommended';

/**
 * Each mode is a declared precedence, exported so a screen can show the pharmacy
 * exactly what it sorted by. Sponsorship appears in none of them.
 */
export const SORT_CRITERIA: Readonly<Record<
  Exclude<SortMode, 'recommended'>,
  readonly RankingCriterion[]
>> = {
  price: ['line_total', 'lead_time_days', 'fulfilment_rate', 'supplier_id'],
  lead_time: ['lead_time_days', 'line_total', 'fulfilment_rate', 'supplier_id'],
  rating: ['fulfilment_rate', 'line_total', 'lead_time_days', 'supplier_id'],
  available_quantity: ['available_quantity', 'line_total', 'lead_time_days', 'supplier_id'],
};

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

export type RankingFilters = Readonly<{
  maxLeadTimeDays?: number;
  maxUnitPrice?: string;
  minFulfilmentRate?: string;
  minAvailableQuantity?: string;
  excludeSponsored?: boolean;
}>;

export type RankingOptions = Readonly<{
  sortMode?: SortMode;
  filters?: RankingFilters;
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

export type FilterReason =
  | 'filtered_lead_time'
  | 'filtered_price'
  | 'filtered_rating'
  | 'filtered_available_quantity'
  | 'filtered_sponsored';

export type RankedOffer = Readonly<{
  offerId: string;
  supplierId: string;
  rank: number;
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number;
  availableQuantity: string;
  performance: SupplierPerformanceRating;
  sponsored: boolean;
  differsFromLeaderAt: RankingCriterion | null;
}>;

export type ExcludedOffer = Readonly<{
  offerId: string;
  supplierId: string;
  reason: ExclusionReason;
}>;

export type FilteredOffer = Readonly<{
  offerId: string;
  supplierId: string;
  reason: FilterReason;
}>;

export type SupplyRanking = Readonly<{
  needId: string;
  sortMode: SortMode;
  criteria: readonly RankingCriterion[];
  filters: RankingFilters;
  ranked: readonly RankedOffer[];
  excluded: readonly ExcludedOffer[];
  filtered: readonly FilteredOffer[];
  sponsoredCount: number;
  unratedCount: number;
}>;

export type RankingRefusalReason =
  | 'invalid_need'
  | 'invalid_filter'
  | 'mixed_rating_comparison'
  | 'recommended_sort_undefined';

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
 * or faster offer would not be neutral, whatever it was called, so every sort
 * mode reads only the criteria SORT_CRITERIA declares for it.
 *
 * Comparing a rated supplier against an unrated one is refused rather than
 * resolved. Falling back to the identity tiebreaker for mixed pairs produces a
 * comparator with cycles: given three offers tied on everything ahead of the
 * rate, where A is rated 0.5, B is unrated and C is rated 0.9, identity puts A
 * before B and B before C while rate puts C before A. A sort built on that is
 * order-dependent and silently wrong, so the mixed case is named and refused
 * until the ranking policy for unrated suppliers is decided.
 */
export function rankEligibleSupply(
  need: NeedLine,
  offers: readonly SupplierOffer[],
  standings: readonly SupplierStanding[],
  options: RankingOptions = {},
): SupplyRankingResult {
  const sortMode = options.sortMode ?? 'price';
  const filters = options.filters ?? {};

  if (sortMode === 'recommended') {
    return {
      kind: 'refused',
      reason: 'recommended_sort_undefined',
      detail: 'no disclosed weighting has been agreed for a recommended sort',
    };
  }

  const needQuantitySign = compareDecimals(need.quantity, '0');
  if (needQuantitySign === undefined || needQuantitySign <= 0) {
    return { kind: 'refused', reason: 'invalid_need', detail: need.needId };
  }

  const invalidFilter = firstInvalidFilter(filters);
  if (invalidFilter !== undefined) {
    return { kind: 'refused', reason: 'invalid_filter', detail: invalidFilter };
  }

  const criteria = SORT_CRITERIA[sortMode];
  const standingBySupplier = new Map(standings.map((entry) => [entry.supplierId, entry]));
  const eligible: EligibleOffer[] = [];
  const excluded: ExcludedOffer[] = [];
  const filtered: FilteredOffer[] = [];

  for (const offer of offers) {
    const assessed = assessOffer(need, offer, standingBySupplier.get(offer.supplierId));
    if (typeof assessed === 'string') {
      excluded.push({ offerId: offer.offerId, supplierId: offer.supplierId, reason: assessed });
      continue;
    }

    const filterReason = firstFailedFilter(assessed, filters);
    if (filterReason !== undefined) {
      filtered.push({ offerId: offer.offerId, supplierId: offer.supplierId, reason: filterReason });
      continue;
    }
    eligible.push(assessed);
  }

  const mixedGroup = firstMixedRatingGroup(eligible, criteria);
  if (mixedGroup !== undefined) {
    return { kind: 'refused', reason: 'mixed_rating_comparison', detail: mixedGroup };
  }

  eligible.sort((left, right) => compareEligibleOffers(criteria, left, right));

  const leader = eligible[0];
  const ranked = eligible.map((entry, index) => Object.freeze({
    offerId: entry.offer.offerId,
    supplierId: entry.offer.supplierId,
    rank: index + 1,
    unitPrice: entry.offer.unitPrice,
    lineTotal: entry.lineTotal,
    leadTimeDays: entry.offer.leadTimeDays,
    availableQuantity: entry.offer.availableQuantity,
    performance: entry.performance,
    sponsored: entry.offer.sponsored,
    differsFromLeaderAt: leader === undefined ? null : firstDifference(criteria, leader, entry),
  }));

  return {
    kind: 'ranked',
    ranking: Object.freeze({
      needId: need.needId,
      sortMode,
      criteria,
      filters,
      ranked: Object.freeze(ranked),
      excluded: Object.freeze(excluded),
      filtered: Object.freeze(filtered),
      sponsoredCount: ranked.filter((entry) => entry.sponsored).length,
      unratedCount: ranked.filter((entry) => entry.performance.kind === 'unrated').length,
    }),
  };
}

function firstInvalidFilter(filters: RankingFilters): string | undefined {
  if (filters.maxLeadTimeDays !== undefined
    && (!Number.isSafeInteger(filters.maxLeadTimeDays) || filters.maxLeadTimeDays < 0)) {
    return 'maxLeadTimeDays';
  }
  if (filters.maxUnitPrice !== undefined && !nonNegativeAmount(filters.maxUnitPrice)) {
    return 'maxUnitPrice';
  }
  if (filters.minAvailableQuantity !== undefined && !nonNegativeAmount(filters.minAvailableQuantity)) {
    return 'minAvailableQuantity';
  }
  if (filters.minFulfilmentRate !== undefined && !proportion(filters.minFulfilmentRate)) {
    return 'minFulfilmentRate';
  }
  return undefined;
}

/**
 * A filter is the pharmacy narrowing its own field, which is a different thing
 * from an offer that was never eligible. They are reported separately so a
 * purchaser can tell "your ceiling removed two" from "two suppliers cannot
 * sell you this at all".
 */
function firstFailedFilter(
  entry: EligibleOffer,
  filters: RankingFilters,
): FilterReason | undefined {
  if (filters.excludeSponsored === true && entry.offer.sponsored) {
    return 'filtered_sponsored';
  }
  if (filters.maxLeadTimeDays !== undefined && entry.offer.leadTimeDays > filters.maxLeadTimeDays) {
    return 'filtered_lead_time';
  }
  if (filters.maxUnitPrice !== undefined
    && (compareDecimals(entry.offer.unitPrice, filters.maxUnitPrice) ?? 0) > 0) {
    return 'filtered_price';
  }
  if (filters.minAvailableQuantity !== undefined
    && (compareDecimals(entry.offer.availableQuantity, filters.minAvailableQuantity) ?? 0) < 0) {
    return 'filtered_available_quantity';
  }
  if (filters.minFulfilmentRate !== undefined) {
    if (entry.performance.kind === 'unrated') {
      return 'filtered_rating';
    }
    if ((compareDecimals(entry.performance.fulfilmentRate, filters.minFulfilmentRate) ?? 0) < 0) {
      return 'filtered_rating';
    }
  }
  return undefined;
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
  return performance.kind === 'unrated' || proportion(performance.fulfilmentRate);
}

function proportion(value: string): boolean {
  const lower = compareDecimals(value, '0');
  const upper = compareDecimals(value, '1');
  return lower !== undefined && upper !== undefined && lower >= 0 && upper <= 0;
}

function nonNegativeAmount(value: string): boolean {
  const sign = compareDecimals(value, '0');
  return sign !== undefined && sign >= 0;
}

/**
 * Only the criteria ahead of the rate can separate two offers before the rate
 * is consulted, so those are what decide whether a mixed pair ever meets. When
 * the rate leads the precedence there is nothing ahead of it and any mix at all
 * is refused, which is the honest answer: sorting by rating is not defined
 * while some suppliers have none.
 */
function firstMixedRatingGroup(
  eligible: readonly EligibleOffer[],
  criteria: readonly RankingCriterion[],
): string | undefined {
  const rateIndex = criteria.indexOf('fulfilment_rate');
  if (rateIndex === -1) {
    return undefined;
  }
  const preceding = criteria.slice(0, rateIndex);

  const groups = new Map<string, { rated: boolean; unrated: boolean }>();
  for (const entry of eligible) {
    const key = preceding.map((criterion) => criterionKey(criterion, entry)).join('@');
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

function criterionKey(criterion: RankingCriterion, entry: EligibleOffer): string {
  if (criterion === 'line_total') {
    return entry.lineTotal;
  }
  if (criterion === 'lead_time_days') {
    return String(entry.offer.leadTimeDays);
  }
  if (criterion === 'available_quantity') {
    return entry.offer.availableQuantity;
  }
  return entry.offer.supplierId;
}

function compareEligibleOffers(
  criteria: readonly RankingCriterion[],
  left: EligibleOffer,
  right: EligibleOffer,
): number {
  for (const criterion of criteria) {
    const order = compareCriterion(criterion, left, right);
    if (order !== 0) {
      return order;
    }
  }
  return compareSupplierIds(left.offer.supplierId, right.offer.supplierId);
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
  if (criterion === 'available_quantity') {
    return compareDecimals(right.offer.availableQuantity, left.offer.availableQuantity) ?? 0;
  }
  if (criterion === 'fulfilment_rate') {
    if (left.performance.kind !== 'rated' || right.performance.kind !== 'rated') {
      return 0;
    }
    return compareDecimals(right.performance.fulfilmentRate, left.performance.fulfilmentRate) ?? 0;
  }
  return compareSupplierIds(left.offer.supplierId, right.offer.supplierId);
}

function firstDifference(
  criteria: readonly RankingCriterion[],
  leader: EligibleOffer,
  candidate: EligibleOffer,
): RankingCriterion | null {
  for (const criterion of criteria) {
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
