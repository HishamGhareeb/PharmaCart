import {
  addDecimals,
  compareDecimals,
  divideDecimals,
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
  | 'unreadable_amount';

export type PerformanceDerivation =
  | Readonly<{ kind: 'derived'; performance: SupplierPerformance }>
  | Readonly<{ kind: 'refused'; reason: PerformanceRefusalReason }>;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * An order whose outcome nobody knows is excluded rather than scored. Counting
 * it as a failure punishes a supplier for our own lost acknowledgement, and
 * counting it as a success hides a real one. The same reasoning drives the
 * sample floor: a supplier with one good order is unmeasured, not excellent,
 * and publishing a perfect rate would put it top of a neutral ranking on noise.
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

  let orderedTotal = '0';
  let deliveredTotal = '0';
  let leadTimeDaysTotal = 0;
  let completedOrders = 0;
  let excludedUnknownOutcome = 0;
  let excludedCancelled = 0;
  let outstandingOrders = 0;
  let longestOutstandingDays = 0;

  for (const order of mine) {
    const placedAt = Date.parse(order.placedAt);
    if (Number.isNaN(placedAt)) {
      return refuse('unordered_timeline');
    }

    if (order.outcome.kind === 'unknown') {
      excludedUnknownOutcome += 1;
      continue;
    }
    if (order.outcome.kind === 'cancelled_by_pharmacy') {
      excludedCancelled += 1;
      continue;
    }
    if (order.outcome.kind === 'outstanding') {
      outstandingOrders += 1;
      longestOutstandingDays = Math.max(
        longestOutstandingDays,
        (evaluatedAt - placedAt) / MILLISECONDS_PER_DAY,
      );
      continue;
    }

    const received = order.outcome.kind === 'delivered' ? order.outcome.deliveredQuantity : '0';
    const nextOrdered = addDecimals(orderedTotal, order.orderedQuantity);
    const nextDelivered = addDecimals(deliveredTotal, received);
    if (nextOrdered === undefined || nextDelivered === undefined) {
      return refuse('unreadable_amount');
    }
    orderedTotal = nextOrdered;
    deliveredTotal = nextDelivered;

    if (order.outcome.kind === 'delivered') {
      const deliveredAt = Date.parse(order.outcome.deliveredAt);
      if (Number.isNaN(deliveredAt) || deliveredAt < placedAt) {
        return refuse('unordered_timeline');
      }
      leadTimeDaysTotal += (deliveredAt - placedAt) / MILLISECONDS_PER_DAY;
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
  const observedLeadTimeDays = divideDecimals(
    String(leadTimeDaysTotal),
    String(completedOrders),
    policy.rateScale,
  );
  if (fulfilmentRate === undefined || observedLeadTimeDays === undefined) {
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
      leadTimeUnderstated: longestOutstandingDays > leadTimeDaysTotal / completedOrders,
    }),
  };
}

function refuse(reason: PerformanceRefusalReason): PerformanceDerivation {
  return { kind: 'refused', reason };
}
