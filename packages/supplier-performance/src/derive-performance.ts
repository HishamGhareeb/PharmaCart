import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
} from '../../exact-decimal/src/exact-decimal.ts';

export type OrderOutcome =
  | Readonly<{ kind: 'delivered'; deliveredAt: string; deliveredQuantity: string }>
  | Readonly<{ kind: 'rejected_by_supplier' }>
  | Readonly<{ kind: 'outstanding' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'cancelled_by_pharmacy' }>;

export type SupplierOrderRecord = Readonly<{
  orderId: string;
  supplierId: string;
  placedAt: string;
  orderedQuantity: string;
  unit: string;
  outcome: OrderOutcome;
}>;

export type PerformancePolicy = Readonly<{
  minimumCompletedOrders: number;
  rateScale: number;
}>;

export type SupplierPerformance = Readonly<{
  supplierId: string;
  fulfilmentRate: string;
  observedLeadTimeDays: string;
  completedOrders: number;
  excludedUnknownOutcome: number;
  excludedCancelled: number;
  outstandingOrders: number;
  leadTimeUnderstated: boolean;
}>;

export type PerformanceRefusalReason =
  | 'invalid_policy'
  | 'insufficient_sample'
  | 'unordered_timeline'
  | 'unit_mismatch'
  | 'unreadable_amount'
  | 'negative_quantity'
  | 'delivered_exceeds_ordered';

export type PerformanceDerivation =
  | Readonly<{ kind: 'derived'; performance: SupplierPerformance }>
  | Readonly<{ kind: 'refused'; reason: PerformanceRefusalReason }>;

const MILLISECONDS_PER_DAY = 86_400_000;

type ValidatedOrder = Readonly<{
  record: SupplierOrderRecord;
  placedAt: number;
  deliveredAt: number | null;
}>;

/**
 * An order whose outcome nobody knows is excluded rather than scored. Counting
 * it as a failure punishes a supplier for our own lost acknowledgement, and
 * counting it as a success hides a real one. The same reasoning drives the
 * sample floor: a supplier with one good order is unmeasured, not excellent,
 * and publishing a perfect rate would put it top of a neutral ranking on noise.
 *
 * Every record is validated before any of them are excluded, so a malformed
 * order cannot hide behind an outcome that would have dropped it unread.
 *
 * Elapsed time accumulates as integer milliseconds and is converted to days
 * once, through exact decimal division. Summing fractional days in floating
 * point drifts, and a total small enough to render in exponential notation
 * stops being a decimal string at all.
 */
export function deriveSupplierPerformance(
  supplierId: string,
  orders: readonly SupplierOrderRecord[],
  policy: PerformancePolicy,
  asOf: string,
): PerformanceDerivation {
  if (!Number.isSafeInteger(policy.minimumCompletedOrders) || policy.minimumCompletedOrders < 1) {
    return refuse('invalid_policy');
  }
  if (!Number.isSafeInteger(policy.rateScale) || policy.rateScale < 0 || policy.rateScale > 32) {
    return refuse('invalid_policy');
  }

  const evaluatedAt = Date.parse(asOf);
  if (Number.isNaN(evaluatedAt)) {
    return refuse('unordered_timeline');
  }

  const mine = orders.filter((order) => order.supplierId === supplierId);
  const unit = mine.find((order) => order.outcome.kind !== 'cancelled_by_pharmacy')?.unit;
  if (unit !== undefined && mine.some((order) => order.unit !== unit)) {
    return refuse('unit_mismatch');
  }

  const validated = validateOrders(mine);
  if (typeof validated === 'string') {
    return refuse(validated);
  }

  let orderedTotal = '0';
  let deliveredTotal = '0';
  let leadTimeMilliseconds = 0;
  let completedOrders = 0;
  let excludedUnknownOutcome = 0;
  let excludedCancelled = 0;
  let outstandingOrders = 0;
  let longestOutstandingMilliseconds = 0;

  for (const entry of validated) {
    const outcome = entry.record.outcome;

    if (outcome.kind === 'unknown') {
      excludedUnknownOutcome += 1;
      continue;
    }
    if (outcome.kind === 'cancelled_by_pharmacy') {
      excludedCancelled += 1;
      continue;
    }
    if (outcome.kind === 'outstanding') {
      outstandingOrders += 1;
      longestOutstandingMilliseconds = Math.max(
        longestOutstandingMilliseconds,
        evaluatedAt - entry.placedAt,
      );
      continue;
    }

    const received = outcome.kind === 'delivered' ? outcome.deliveredQuantity : '0';
    const nextOrdered = addDecimals(orderedTotal, entry.record.orderedQuantity);
    const nextDelivered = addDecimals(deliveredTotal, received);
    if (nextOrdered === undefined || nextDelivered === undefined) {
      return refuse('unreadable_amount');
    }
    orderedTotal = nextOrdered;
    deliveredTotal = nextDelivered;

    if (entry.deliveredAt !== null) {
      leadTimeMilliseconds += entry.deliveredAt - entry.placedAt;
    }
    completedOrders += 1;
  }

  if (completedOrders < policy.minimumCompletedOrders) {
    return refuse('insufficient_sample');
  }
  if (compareDecimals(orderedTotal, '0') === 0) {
    return refuse('insufficient_sample');
  }

  const fulfilmentRate = divideDecimals(deliveredTotal, orderedTotal, policy.rateScale);
  const elapsedDenominator = multiplyDecimals(String(completedOrders), String(MILLISECONDS_PER_DAY));
  const observedLeadTimeDays = elapsedDenominator === undefined
    ? undefined
    : divideDecimals(String(leadTimeMilliseconds), elapsedDenominator, policy.rateScale);
  const scaledOutstanding = multiplyDecimals(
    String(longestOutstandingMilliseconds),
    String(completedOrders),
  );
  if (fulfilmentRate === undefined || observedLeadTimeDays === undefined || scaledOutstanding === undefined) {
    return refuse('unreadable_amount');
  }

  return {
    kind: 'derived',
    performance: Object.freeze({
      supplierId,
      fulfilmentRate,
      observedLeadTimeDays,
      completedOrders,
      excludedUnknownOutcome,
      excludedCancelled,
      outstandingOrders,
      leadTimeUnderstated: (compareDecimals(scaledOutstanding, String(leadTimeMilliseconds)) ?? 0) > 0,
    }),
  };
}

function validateOrders(
  orders: readonly SupplierOrderRecord[],
): readonly ValidatedOrder[] | PerformanceRefusalReason {
  const validated: ValidatedOrder[] = [];

  for (const record of orders) {
    const placedAt = Date.parse(record.placedAt);
    if (Number.isNaN(placedAt)) {
      return 'unordered_timeline';
    }

    const orderedSign = compareDecimals(record.orderedQuantity, '0');
    if (orderedSign === undefined) {
      return 'unreadable_amount';
    }
    if (orderedSign < 0) {
      return 'negative_quantity';
    }

    if (record.outcome.kind !== 'delivered') {
      validated.push({ record, placedAt, deliveredAt: null });
      continue;
    }

    const deliveredAt = Date.parse(record.outcome.deliveredAt);
    if (Number.isNaN(deliveredAt) || deliveredAt < placedAt) {
      return 'unordered_timeline';
    }

    const deliveredSign = compareDecimals(record.outcome.deliveredQuantity, '0');
    if (deliveredSign === undefined) {
      return 'unreadable_amount';
    }
    if (deliveredSign < 0) {
      return 'negative_quantity';
    }
    if ((compareDecimals(record.outcome.deliveredQuantity, record.orderedQuantity) ?? 0) > 0) {
      return 'delivered_exceeds_ordered';
    }

    validated.push({ record, placedAt, deliveredAt });
  }

  return validated;
}

function refuse(reason: PerformanceRefusalReason): PerformanceDerivation {
  return { kind: 'refused', reason };
}
