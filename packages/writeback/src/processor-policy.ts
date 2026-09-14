/** Pure policy for the receipt writeback processor: its bounds, the deadline every sink call runs under,
 * and how a sink failure is classified. Nothing here touches PostgreSQL or the filesystem, so every rule
 * that decides whether a writeback may be sent again is testable without a database.
 *
 * The processor itself lives in packages/db/src/writeback.ts. See docs/receipt-writeback.md. */

/** Every wait, lease and retry count is finite. An unbounded lease cannot be recovered from a crashed
 * worker, an unbounded attempt count turns a permanent fault into an endless loop, and an unbounded sink
 * call turns a hung stock system into a hung worker. */
export const writebackProcessorLimits = {
  leaseMs: { min: 1_000, max: 600_000, default: 30_000 },
  maxAttempts: { min: 1, max: 100, default: 5 },
  batch: { min: 1, max: 200, default: 25 },
  lockTimeoutMs: { min: 100, max: 60_000, default: 5_000 },
  sinkCallTimeoutMs: { min: 50, max: 300_000, default: 10_000 },
  retryDelayMs: { min: 0, max: 3_600_000, default: 5_000 },
} as const;

export type WritebackProcessorOptionName = keyof typeof writebackProcessorLimits;
export type WritebackProcessorOptions = { [name in WritebackProcessorOptionName]?: number };
export type ResolvedWritebackProcessorOptions = Readonly<{ [name in WritebackProcessorOptionName]: number }>;

const optionNames = Object.keys(writebackProcessorLimits) as WritebackProcessorOptionName[];

function bounded(name: WritebackProcessorOptionName, value: unknown): number {
  const { min, max } = writebackProcessorLimits[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number between ${min} and ${max}; received ${String(value)}`);
  }
  return value;
}

/** Resolves and validates processor options. A configuration fault is refused at construction rather
 * than discovered part way through a claim.
 *
 * One cross-field rule matters for correctness: a sink call must be abandoned well before the lease that
 * covers it expires. Each sink call runs under a lease freshly extended to `leaseMs`, and the call is cut
 * off at `sinkCallTimeoutMs`, so requiring the lease to be at least twice the call bound leaves room for
 * the settling transaction and for the database clock and this process's timer disagreeing. */
export function resolveWritebackProcessorOptions(options: WritebackProcessorOptions = {}): ResolvedWritebackProcessorOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new RangeError('writeback processor options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!optionNames.includes(key as WritebackProcessorOptionName)) {
      throw new RangeError(`unknown writeback processor option ${JSON.stringify(key)}`);
    }
  }
  const resolved = {
    leaseMs: bounded('leaseMs', options.leaseMs ?? writebackProcessorLimits.leaseMs.default),
    maxAttempts: bounded('maxAttempts', options.maxAttempts ?? writebackProcessorLimits.maxAttempts.default),
    batch: bounded('batch', options.batch ?? writebackProcessorLimits.batch.default),
    lockTimeoutMs: bounded('lockTimeoutMs', options.lockTimeoutMs ?? writebackProcessorLimits.lockTimeoutMs.default),
    sinkCallTimeoutMs: bounded('sinkCallTimeoutMs', options.sinkCallTimeoutMs ?? writebackProcessorLimits.sinkCallTimeoutMs.default),
    retryDelayMs: bounded('retryDelayMs', options.retryDelayMs ?? writebackProcessorLimits.retryDelayMs.default),
  };
  if (resolved.sinkCallTimeoutMs * 2 > resolved.leaseMs) {
    throw new RangeError(`leaseMs (${resolved.leaseMs}) must be at least twice sinkCallTimeoutMs (${resolved.sinkCallTimeoutMs}) so a sink call is abandoned before its lease can expire`);
  }
  return resolved;
}

/** The result of one bounded sink call. `timed_out` means this process stopped waiting; it says nothing
 * about whether the sink acted, which is exactly why it is never read as a refusal. */
export type BoundedCall<T> =
  | { kind: 'answered'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timed_out'; afterMs: number };

/** Runs one sink call under a deadline. The underlying call is not cancelled, because a promise cannot be,
 * so a call abandoned here may still complete later; the processor is written so that a late completion
 * can only ever add positive evidence, never a second send. The timer is cleared as soon as either side
 * settles and is deliberately not unref'd: a worker awaiting a hung sink must stay alive to record the
 * timeout rather than exit silently with the attempt unrecorded. */
export async function callWithDeadline<T>(call: () => Promise<T>, deadlineMs: number): Promise<BoundedCall<T>> {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) throw new RangeError(`deadlineMs must be a positive whole number; received ${String(deadlineMs)}`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<BoundedCall<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed_out', afterMs: deadlineMs }), deadlineMs);
  });
  const attempt = (async (): Promise<BoundedCall<T>> => {
    try {
      return { kind: 'answered', value: await call() };
    } catch (error) {
      return { kind: 'failed', error };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reasons a writeback is held for an operator. Each one names a fact a worker cannot resolve by retrying. */
export type WritebackHoldReason =
  | 'attempts_exhausted'
  | 'payload_unbuildable'
  | 'payload_changed'
  | 'sink_key_changed'
  | 'attempt_status_disagree'
  | 'evidence_mismatch'
  | 'receipt_changed_during_call'
  | 'sink_receipt_conflict'
  | 'sink_ledger_corrupt'
  | 'sink_ledger_too_large'
  | 'payload_invalid'
  | 'not_found_without_idempotency';

/** How an `apply` that did not return evidence is treated.
 *
 * - `not_recorded`: the sink states it wrote nothing (exclusive access was never obtained). A bounded
 *   further attempt is safe.
 * - `refused`: the sink definitively refused. Retrying cannot change the answer, so the writeback is held.
 * - `no_answer`: the sink may or may not have recorded the receipt. Only a lookup may settle it; it is
 *   never resent on this evidence. A timeout is always `no_answer`. */
export type ApplyFailure =
  | { kind: 'not_recorded'; reason: 'sink_ledger_locked'; detail: string }
  | { kind: 'refused'; reason: 'sink_receipt_conflict' | 'sink_ledger_corrupt' | 'sink_ledger_too_large' | 'payload_invalid'; detail: string }
  | { kind: 'no_answer'; reason: 'sink_no_answer' | 'sink_timeout'; detail: string };

const refusedCodes = {
  SINK_RECEIPT_CONFLICT: 'sink_receipt_conflict',
  SINK_LEDGER_CORRUPT: 'sink_ledger_corrupt',
  SINK_LEDGER_TOO_LARGE: 'sink_ledger_too_large',
  WRITEBACK_PAYLOAD_INVALID: 'payload_invalid',
} as const;

const detailLimit = 1024;

/** A bounded, single-line description of a failure for the attempt record. */
export function describeFailure(call: Exclude<BoundedCall<unknown>, { kind: 'answered' }>): string {
  if (call.kind === 'timed_out') return `no answer within ${call.afterMs}ms`;
  const error = call.error;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'SINK_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return `${code}: ${message}`.replace(/[\r\n]+/g, ' ').slice(0, detailLimit);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyApplyFailure(call: Exclude<BoundedCall<unknown>, { kind: 'answered' }>): ApplyFailure {
  const detail = describeFailure(call);
  if (call.kind === 'timed_out') return { kind: 'no_answer', reason: 'sink_timeout', detail };
  const code = errorCode(call.error);
  if (code === 'SINK_LEDGER_LOCKED') return { kind: 'not_recorded', reason: 'sink_ledger_locked', detail };
  if (code !== undefined && Object.hasOwn(refusedCodes, code)) {
    return { kind: 'refused', reason: refusedCodes[code as keyof typeof refusedCodes], detail };
  }
  // Anything unrecognised gave no answer. Guessing that an unknown error means "nothing was written" is
  // exactly the blind resend this classification exists to prevent.
  return { kind: 'no_answer', reason: 'sink_no_answer', detail };
}

/** A lookup that did not answer is inconclusive in every case: it proves nothing in either direction. */
export function classifyLookupFailure(call: Exclude<BoundedCall<unknown>, { kind: 'answered' }>): { reason: 'lookup_timeout' | 'lookup_unavailable'; detail: string } {
  return { reason: call.kind === 'timed_out' ? 'lookup_timeout' : 'lookup_unavailable', detail: describeFailure(call) };
}
