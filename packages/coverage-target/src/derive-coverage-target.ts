import {
  addDecimals,
  ceilDecimal,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  subtractDecimals,
} from '../../exact-decimal/src/exact-decimal.ts';

export type StockObservation = Readonly<{
  observedAt: string;
  onHand: string;
  unit: string;
}>;

export type StockReceipt = Readonly<{
  receivedAt: string;
  quantity: string;
  unit: string;
}>;

export type CoveragePolicy = Readonly<{
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyDays: number;
  minimumIntervals: number;
  rateScale: number;
}>;

export type DerivedCoverageTarget = Readonly<{
  sourceCode: string;
  unit: string;
  dailyConsumption: string;
  observedDays: string;
  coverageDays: number;
  targetQuantity: string;
  intervalsUsed: number;
  intervalsCensored: number;
}>;

export type CoverageRefusalReason =
  | 'invalid_policy'
  | 'insufficient_history'
  | 'unordered_history'
  | 'unit_mismatch'
  | 'unreadable_amount'
  | 'negative_consumption'
  | 'all_intervals_censored';

export type CoverageDerivation =
  | Readonly<{ kind: 'derived'; target: DerivedCoverageTarget }>
  | Readonly<{ kind: 'refused'; reason: CoverageRefusalReason }>;

const MILLISECONDS_PER_DAY = 86_400_000;
const DAY_SCALE = 6;

/**
 * A stockout censors demand rather than measuring it. Once the shelf is empty
 * the pharmacy stops selling because it has nothing left, not because nobody
 * wanted any, so the fall in stock across that interval is a lower bound on
 * demand and not a reading of it. Averaging those intervals in produces a rate
 * that is too low, a target that is too small, and a shelf that empties again.
 * They are excluded and counted, never quietly included.
 */
export function deriveCoverageTarget(
  sourceCode: string,
  observations: readonly StockObservation[],
  receipts: readonly StockReceipt[],
  policy: CoveragePolicy,
): CoverageDerivation {
  const coverageDays = validCoverageDays(policy);
  if (coverageDays === undefined) {
    return refuse('invalid_policy');
  }
  if (observations.length < 2 || observations.length - 1 < policy.minimumIntervals) {
    return refuse('insufficient_history');
  }

  const unit = observations[0]!.unit;
  if (observations.some((entry) => entry.unit !== unit)
    || receipts.some((entry) => entry.unit !== unit)) {
    return refuse('unit_mismatch');
  }

  let totalConsumption = '0';
  let totalDays = '0';
  let intervalsUsed = 0;
  let intervalsCensored = 0;

  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;

    const openedAt = Date.parse(previous.observedAt);
    const closedAt = Date.parse(current.observedAt);
    if (Number.isNaN(openedAt) || Number.isNaN(closedAt) || closedAt <= openedAt) {
      return refuse('unordered_history');
    }

    const delivered = receiptsWithin(receipts, openedAt, closedAt);
    if (delivered === undefined) {
      return refuse('unreadable_amount');
    }

    const available = addDecimals(previous.onHand, delivered);
    const consumption = available === undefined
      ? undefined
      : subtractDecimals(available, current.onHand);
    const sign = consumption === undefined ? undefined : compareDecimals(consumption, '0');
    if (consumption === undefined || sign === undefined) {
      return refuse('unreadable_amount');
    }
    if (sign < 0) {
      return refuse('negative_consumption');
    }

    if (isEmpty(previous.onHand) || isEmpty(current.onHand)) {
      intervalsCensored += 1;
      continue;
    }

    const days = divideDecimals(String(closedAt - openedAt), String(MILLISECONDS_PER_DAY), DAY_SCALE);
    const nextConsumption = days === undefined ? undefined : addDecimals(totalConsumption, consumption);
    const nextDays = days === undefined ? undefined : addDecimals(totalDays, days);
    if (nextConsumption === undefined || nextDays === undefined) {
      return refuse('unreadable_amount');
    }

    totalConsumption = nextConsumption;
    totalDays = nextDays;
    intervalsUsed += 1;
  }

  if (intervalsUsed === 0) {
    return refuse('all_intervals_censored');
  }
  if (intervalsUsed < policy.minimumIntervals) {
    return refuse('insufficient_history');
  }

  const dailyConsumption = divideDecimals(totalConsumption, totalDays, policy.rateScale);
  const coverage = dailyConsumption === undefined
    ? undefined
    : multiplyDecimals(dailyConsumption, String(coverageDays));
  const targetQuantity = coverage === undefined ? undefined : ceilDecimal(coverage);
  if (dailyConsumption === undefined || targetQuantity === undefined) {
    return refuse('unreadable_amount');
  }

  return {
    kind: 'derived',
    target: Object.freeze({
      sourceCode,
      unit,
      dailyConsumption,
      observedDays: totalDays,
      coverageDays,
      targetQuantity,
      intervalsUsed,
      intervalsCensored,
    }),
  };
}

function receiptsWithin(
  receipts: readonly StockReceipt[],
  openedAt: number,
  closedAt: number,
): string | undefined {
  let total = '0';
  for (const receipt of receipts) {
    const receivedAt = Date.parse(receipt.receivedAt);
    if (Number.isNaN(receivedAt) || receivedAt <= openedAt || receivedAt > closedAt) {
      continue;
    }
    const next = addDecimals(total, receipt.quantity);
    if (next === undefined) {
      return undefined;
    }
    total = next;
  }
  return total;
}

function isEmpty(quantity: string): boolean {
  return compareDecimals(quantity, '0') === 0;
}

function validCoverageDays(policy: CoveragePolicy): number | undefined {
  const days = [policy.leadTimeDays, policy.reviewPeriodDays, policy.safetyDays];
  if (days.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return undefined;
  }
  if (!Number.isSafeInteger(policy.minimumIntervals) || policy.minimumIntervals < 1) {
    return undefined;
  }
  if (!Number.isSafeInteger(policy.rateScale) || policy.rateScale < 0 || policy.rateScale > 32) {
    return undefined;
  }

  const total = days.reduce((left, right) => left + right, 0);
  return total > 0 ? total : undefined;
}

function refuse(reason: CoverageRefusalReason): CoverageDerivation {
  return { kind: 'refused', reason };
}
