import { strictInstantMs } from './instant.ts';

/**
 * What a dispatcher may do with a delivery whose outcome it has to establish, as pure decisions.
 *
 * The rules mirror the order path (docs/testing/order-recovery-concurrency.md). A lookup can settle
 * a delivery the sink holds. A not-found answer only describes the sink at the moment it was asked,
 * so it may release a claim that provably never sent anything, may mark an interrupted send as
 * unknown, and may escalate a known-unknown send to a person, but it never authorises a second send.
 */

export type LookupResult = 'found' | 'not_found' | 'failed';

export type ReconciliationEligibility =
  | Readonly<{ kind: 'eligible' }>
  | Readonly<{ kind: 'ineligible'; reason: 'lease_active' | 'not_unsettled' | 'invalid_instant' }>;

export type ReconciliationPlan =
  | Readonly<{ kind: 'settle_delivered' }>
  | Readonly<{ kind: 'release'; reason: 'claim_abandoned' }>
  | Readonly<{ kind: 'mark_unknown'; reason: 'lease_expired_unsettled' }>
  | Readonly<{ kind: 'record_lookup_failure' }>
  | Readonly<{ kind: 'manual_review'; reason: 'not_found_after_unknown' | 'lookup_attempts_exhausted' }>;

export type PreSendPlan =
  | Readonly<{ kind: 'settle_delivered' }>
  | Readonly<{ kind: 'send' }>
  | Readonly<{ kind: 'release'; reason: 'lookup_failed' }>
  | Readonly<{ kind: 'manual_review'; reason: 'lookup_attempts_exhausted' }>;

export type DispatcherOptions = Readonly<{
  leaseMs?: number;
  batchSize?: number;
  /** Deadline for each individual sink call, lookup or send. */
  sinkTimeoutMs?: number;
  /** Deadline for waiting on any row lock inside a dispatcher transaction. */
  lockTimeoutMs?: number;
  /**
   * Required to use a sink that reports itself as synthetic. It exists so the development adapter
   * cannot become a deployment default by being the only one wired up.
   */
  allowSyntheticSink?: boolean;
}>;

export type ResolvedDispatcherOptions = Readonly<{
  leaseMs: number;
  batchSize: number;
  sinkTimeoutMs: number;
  lockTimeoutMs: number;
  allowSyntheticSink: boolean;
}>;

export type BoundedResult<T> =
  | Readonly<{ kind: 'returned'; value: T }>
  | Readonly<{ kind: 'threw'; error: unknown }>
  | Readonly<{ kind: 'timed_out' }>;

/** Failed or timed-out lookups one delivery may accumulate before a person has to look at it. */
export const MAX_LOOKUP_FAILURES = 8;

const bounds = {
  leaseMs: { min: 1_000, max: 15 * 60_000, fallback: 60_000 },
  batchSize: { min: 1, max: 100, fallback: 20 },
  sinkTimeoutMs: { min: 1, max: 60_000, fallback: 5_000 },
  lockTimeoutMs: { min: 1, max: 30_000, fallback: 5_000 },
} as const;

function bounded(name: keyof typeof bounds, value: number | undefined): number {
  const { min, max, fallback } = bounds[name];
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be a whole number between ${min} and ${max}; received ${String(resolved)}`);
  }
  return resolved;
}

export function resolveDispatcherOptions(options: DispatcherOptions): ResolvedDispatcherOptions {
  const leaseMs = bounded('leaseMs', options.leaseMs);
  const sinkTimeoutMs = bounded('sinkTimeoutMs', options.sinkTimeoutMs);
  // One claimed delivery makes at most a lookup and a send. If both may run to their deadline and the
  // lease can still expire first, a recovering worker would be entitled to act on a live attempt.
  if (2 * sinkTimeoutMs >= leaseMs) {
    throw new RangeError(`leaseMs (${leaseMs}) must exceed twice sinkTimeoutMs (${sinkTimeoutMs})`);
  }
  return Object.freeze({
    leaseMs,
    batchSize: bounded('batchSize', options.batchSize),
    sinkTimeoutMs,
    lockTimeoutMs: bounded('lockTimeoutMs', options.lockTimeoutMs),
    allowSyntheticSink: options.allowSyntheticSink ?? false,
  });
}

export function resolveLockTimeoutMs(value: number | undefined): number {
  return bounded('lockTimeoutMs', value);
}

/**
 * Only an attempt that has finished, or whose lease says its owner has given up, may be reconciled.
 * A live lease belongs to a worker that may be sending right now.
 */
export function reconciliationEligibility(
  row: Readonly<{ status: string; leaseExpiresAt: string | null }>,
  now: string,
): ReconciliationEligibility {
  if (row.status === 'outcome_unknown') return Object.freeze({ kind: 'eligible' });
  if (row.status !== 'dispatching') return Object.freeze({ kind: 'ineligible', reason: 'not_unsettled' });
  const nowMs = strictInstantMs(now);
  const leaseMs = row.leaseExpiresAt === null ? null : strictInstantMs(row.leaseExpiresAt);
  if (nowMs === null || leaseMs === null) return Object.freeze({ kind: 'ineligible', reason: 'invalid_instant' });
  return nowMs >= leaseMs
    ? Object.freeze({ kind: 'eligible' })
    : Object.freeze({ kind: 'ineligible', reason: 'lease_active' });
}

function lookupBudgetSpent(lookupFailures: number): boolean {
  return !Number.isInteger(lookupFailures) || lookupFailures + 1 >= MAX_LOOKUP_FAILURES;
}

export function planReconciliation(
  row: Readonly<{ status: 'dispatching' | 'outcome_unknown'; sendAttempted: boolean; lookupFailures: number }>,
  lookup: LookupResult,
): ReconciliationPlan {
  if (lookup === 'found') return Object.freeze({ kind: 'settle_delivered' });
  if (lookup === 'failed') {
    return lookupBudgetSpent(row.lookupFailures)
      ? Object.freeze({ kind: 'manual_review', reason: 'lookup_attempts_exhausted' })
      : Object.freeze({ kind: 'record_lookup_failure' });
  }
  if (row.status === 'outcome_unknown') return Object.freeze({ kind: 'manual_review', reason: 'not_found_after_unknown' });
  // An expired claim with no recorded send never reached the sink from this database's history, and
  // the sink confirms it holds nothing. Returning it to pending is what keeps it from being lost.
  return row.sendAttempted
    ? Object.freeze({ kind: 'mark_unknown', reason: 'lease_expired_unsettled' })
    : Object.freeze({ kind: 'release', reason: 'claim_abandoned' });
}

/**
 * Every first send is preceded by a lookup. A restored database can hold a pending row the sink
 * already delivered, and a provider without idempotent accept would push it again.
 */
export function planPreSendLookup(lookup: LookupResult, lookupFailures: number): PreSendPlan {
  if (lookup === 'found') return Object.freeze({ kind: 'settle_delivered' });
  if (lookup === 'not_found') return Object.freeze({ kind: 'send' });
  return lookupBudgetSpent(lookupFailures)
    ? Object.freeze({ kind: 'manual_review', reason: 'lookup_attempts_exhausted' })
    : Object.freeze({ kind: 'release', reason: 'lookup_failed' });
}

/**
 * Runs a sink call against a deadline. A timed-out call is not cancelled - nothing can recall a
 * request already on the wire - so the caller must treat it exactly like a lost answer. A late
 * rejection from the abandoned call is absorbed rather than surfacing as an unhandled rejection.
 */
export async function callWithin<T>(action: () => Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let call: Promise<BoundedResult<T>>;
  try {
    call = action().then(
      (value): BoundedResult<T> => Object.freeze({ kind: 'returned', value }),
      (error: unknown): BoundedResult<T> => Object.freeze({ kind: 'threw', error }),
    );
  } catch (error) {
    return Object.freeze({ kind: 'threw', error });
  }
  const deadline = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve(Object.freeze({ kind: 'timed_out' })), timeoutMs);
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
