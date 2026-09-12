import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  subtractDecimals,
} from '../../exact-decimal/src/exact-decimal.ts';
import {
  rankEligibleSupply,
  type ExcludedOffer,
  type FilteredOffer,
  type NeedLine,
  type RankingCriterion,
  type RankingOptions,
  type RankingRefusalReason,
  type SortMode,
  type SupplierOffer,
  type SupplierPerformanceRating,
  type SupplierStanding,
} from './supply-ranking.ts';

export type AllocationSkipReason = 'need_already_met' | 'remainder_below_minimum';

export type AllocationLine = Readonly<{
  offerId: string;
  supplierId: string;
  rank: number;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number;
  sponsored: boolean;
  performance: SupplierPerformanceRating;
}>;

export type SkippedOffer = Readonly<{
  offerId: string;
  supplierId: string;
  reason: AllocationSkipReason;
}>;

export type SupplyAllocation = Readonly<{
  needId: string;
  sortMode: SortMode;
  criteria: readonly RankingCriterion[];
  requested: string;
  allocated: string;
  unfilled: string;
  complete: boolean;
  totalCost: string;
  effectiveLeadTimeDays: number | null;
  lines: readonly AllocationLine[];
  skipped: readonly SkippedOffer[];
  excluded: readonly ExcludedOffer[];
  filtered: readonly FilteredOffer[];
  sponsoredCount: number;
  unratedCount: number;
}>;

export type SupplyAllocationResult =
  | Readonly<{ kind: 'allocated'; allocation: SupplyAllocation }>
  | Readonly<{ kind: 'refused'; reason: RankingRefusalReason | 'unreadable_amount'; detail: string }>;

/**
 * Fills one need from several suppliers when no single supplier holds enough.
 * Without this the whole-line rule excludes every offer as insufficient stock
 * and tells a pharmacy nothing is available, even where two suppliers together
 * could cover it comfortably.
 *
 * Allocation is greedy in whatever order the ranking produced, so it inherits
 * the pharmacy's own choice of what to optimise and stays explainable: each
 * supplier is offered as much as it can still usefully contribute, in rank
 * order, until the need is met. Sorted by price with no binding minimum order
 * quantities that is also the cheapest achievable split, since the cheapest
 * units are taken first. Where a minimum order quantity does bind, greedy is
 * explainable but not provably optimal, and it does not try to minimise the
 * number of suppliers involved.
 *
 * A short fill is reported, never disguised. `complete` and `unfilled` say
 * plainly that the need could not be met, because an allocation that silently
 * ordered what it found would look identical to one that succeeded.
 */
export function allocateAcrossSuppliers(
  need: NeedLine,
  offers: readonly SupplierOffer[],
  standings: readonly SupplierStanding[],
  options: RankingOptions = {},
): SupplyAllocationResult {
  const ranking = rankEligibleSupply(need, offers, standings, { ...options, coverage: 'partial' });
  if (ranking.kind === 'refused') {
    return { kind: 'refused', reason: ranking.reason, detail: ranking.detail };
  }

  const requested = addDecimals(need.quantity, '0');
  if (requested === undefined) {
    return { kind: 'refused', reason: 'invalid_need', detail: need.needId };
  }

  const lines: AllocationLine[] = [];
  const skipped: SkippedOffer[] = [];
  let remaining = requested;
  let totalCost = '0';

  for (const entry of ranking.ranking.ranked) {
    if (compareDecimals(remaining, '0') === 0) {
      skipped.push({ offerId: entry.offerId, supplierId: entry.supplierId, reason: 'need_already_met' });
      continue;
    }

    const quantity = smaller(remaining, entry.availableQuantity);
    const meetsMinimum = quantity === undefined
      ? undefined
      : compareDecimals(quantity, entry.minimumOrderQuantity);
    if (quantity === undefined || meetsMinimum === undefined) {
      return { kind: 'refused', reason: 'unreadable_amount', detail: entry.offerId };
    }
    if (meetsMinimum < 0) {
      skipped.push({
        offerId: entry.offerId,
        supplierId: entry.supplierId,
        reason: 'remainder_below_minimum',
      });
      continue;
    }

    const lineTotal = multiplyDecimals(entry.unitPrice, quantity);
    const nextRemaining = subtractDecimals(remaining, quantity);
    const nextCost = lineTotal === undefined ? undefined : addDecimals(totalCost, lineTotal);
    if (lineTotal === undefined || nextRemaining === undefined || nextCost === undefined) {
      return { kind: 'refused', reason: 'unreadable_amount', detail: entry.offerId };
    }

    lines.push(Object.freeze({
      offerId: entry.offerId,
      supplierId: entry.supplierId,
      rank: lines.length + 1,
      quantity,
      unitPrice: entry.unitPrice,
      lineTotal,
      leadTimeDays: entry.leadTimeDays,
      sponsored: entry.sponsored,
      performance: entry.performance,
    }));
    remaining = nextRemaining;
    totalCost = nextCost;
  }

  const allocated = subtractDecimals(requested, remaining);
  if (allocated === undefined) {
    return { kind: 'refused', reason: 'unreadable_amount', detail: need.needId };
  }

  return {
    kind: 'allocated',
    allocation: Object.freeze({
      needId: need.needId,
      sortMode: ranking.ranking.sortMode,
      criteria: ranking.ranking.criteria,
      requested,
      allocated,
      unfilled: remaining,
      complete: compareDecimals(remaining, '0') === 0,
      totalCost,
      effectiveLeadTimeDays: effectiveLeadTime(lines),
      lines: Object.freeze(lines),
      skipped: Object.freeze(skipped),
      excluded: ranking.ranking.excluded,
      filtered: ranking.ranking.filtered,
      sponsoredCount: lines.filter((line) => line.sponsored).length,
      unratedCount: lines.filter((line) => line.performance.kind === 'unrated').length,
    }),
  };
}

/**
 * A split arrives when its slowest supplier arrives. Reporting the maximum
 * rather than the leader's lead time stops a cheap split quietly costing a week
 * the purchaser never agreed to.
 */
function effectiveLeadTime(lines: readonly AllocationLine[]): number | null {
  if (lines.length === 0) {
    return null;
  }
  return lines.reduce((slowest, line) => Math.max(slowest, line.leadTimeDays), 0);
}

function smaller(left: string, right: string): string | undefined {
  const order = compareDecimals(left, right);
  if (order === undefined) {
    return undefined;
  }
  return order <= 0 ? left : right;
}
