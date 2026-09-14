import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertSyntheticSinkKey,
  assertWritebackPayload,
  canonicalJson,
  syntheticSinkKey,
  syntheticStockReceiptToken,
  writebackPayloadHash,
  type WritebackLine,
  type WritebackPayload,
} from './payload.ts';

/** A development-only stand-in for a pharmacy stock system.
 *
 * The real system is never contacted by this project. This sink records stock receipts in one local JSON
 * file with no database involvement, so writeback behaviour can be exercised independently of PostgreSQL
 * and can survive a process restart. Construct it through `synthetic-entry.ts`, which is the gate that
 * keeps a synthetic component from becoming a production default.
 *
 * Boundary: recording a stock receipt here is *not* evidence that any later inventory snapshot contains
 * it. That watermark/inclusion boundary is owned by the replenishment lane and is documented in
 * docs/testing/synthetic-writeback.md. */

/** `apply` records and answers; `timeout_after_apply` records and then loses the answer, which is the
 * uncertain outcome reconciliation exists for; `unavailable` never reaches the sink at all. The caller
 * cannot distinguish the last two, which is the point. */
export type SyntheticStockSinkMode = 'apply' | 'timeout_after_apply' | 'unavailable';
export const syntheticStockSinkModes: readonly SyntheticStockSinkMode[] = ['apply', 'timeout_after_apply', 'unavailable'];

export type SyntheticStockSinkOptions = {
  lockWaitMs?: number;
  lockPollMs?: number;
  /** Whether this sink *advertises* that repeating `apply` with one key and payload is safe. It is off by
   * default and is a contract statement, not an observation: the processor must decide whether a retry is
   * permitted from what the sink promises, never from the fact that this implementation happens to
   * deduplicate internally. */
  idempotentApply?: boolean;
  maxLedgerBytes?: number;
};

/** One recorded stock receipt. `stockReceiptId` and `receiptToken` are derived, never random, so a
 * pathological double write cannot produce two identities for one key and a restart reproduces both. */
export type SyntheticStockReceipt = Readonly<{
  sinkKey: string;
  stockReceiptId: string;
  payloadHash: string;
  receiptToken: string;
  lineCount: number;
  lines: readonly WritebackLine[];
}>;

/** `applyCalls` is retained deliberately: it is the evidence that an uncertain outcome was reconciled by
 * lookup rather than resent. There is no lookup counter because {@link SyntheticStockSink.lookup} does
 * not write; see the note on that method. */
export type SyntheticStockSinkLedger = {
  version: 1;
  applyCalls: number;
  receipts: Record<string, SyntheticStockReceipt>;
};

type Marker = { owner: string; pid: number; acquiredAt: string };

/** Exclusive access could not be obtained inside the bound. Nothing was read and nothing was written, so
 * for `apply` this is a *certain* non-delivery that a caller may retry; it must never be read as an empty
 * ledger or as permission to overwrite one. */
export class SinkLedgerLockError extends Error {
  readonly code = 'SINK_LEDGER_LOCKED';
  readonly markerPath: string;

  constructor(markerPath: string, waitedMs: number) {
    super(`Synthetic stock sink ledger remained locked for ${waitedMs}ms; refusing to read or write it`);
    this.name = 'SinkLedgerLockError';
    this.markerPath = markerPath;
  }
}

/** The ledger file exists but is not a ledger this build understands. Refusing is the whole point: read
 * as empty, it would authorise a second stock receipt for an already applied writeback. The bytes are
 * left exactly as found for an operator. */
export class SinkLedgerCorruptError extends Error {
  readonly code = 'SINK_LEDGER_CORRUPT';
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`Synthetic stock sink ledger at ${path} is unreadable (${detail}); refusing to treat it as empty`);
    this.name = 'SinkLedgerCorruptError';
    this.path = path;
    this.detail = detail;
  }
}

/** The ledger is larger than the reviewed bound, so it is refused before being parsed into memory. */
export class SinkLedgerTooLargeError extends Error {
  readonly code = 'SINK_LEDGER_TOO_LARGE';
  readonly path: string;

  constructor(path: string, bytes: number, maxBytes: number) {
    super(`Synthetic stock sink ledger at ${path} is ${bytes} bytes, above the ${maxBytes} byte bound; refusing to read it`);
    this.name = 'SinkLedgerTooLargeError';
    this.path = path;
  }
}

/** One key already holds a stock receipt for a different payload. The durable receipt and the sink
 * disagree; merging them automatically would silently change a recorded quantity. */
export class SinkReceiptConflictError extends Error {
  readonly code = 'SINK_RECEIPT_CONFLICT';
  readonly sinkKey: string;
  readonly recordedPayloadHash: string;
  readonly offeredPayloadHash: string;

  constructor(sinkKey: string, recordedPayloadHash: string, offeredPayloadHash: string) {
    super(`Stock receipt ${sinkKey} already records payload ${recordedPayloadHash}; refusing to replace it with ${offeredPayloadHash}`);
    this.name = 'SinkReceiptConflictError';
    this.sinkKey = sinkKey;
    this.recordedPayloadHash = recordedPayloadHash;
    this.offeredPayloadHash = offeredPayloadHash;
  }
}

/** An `apply` that did not return an answer. The outcome is genuinely unknown: it covers both a sink that
 * recorded the receipt and then lost the connection, and one that was never reached. The caller cannot
 * tell these apart and must not guess — only a lookup can settle it. */
export class SinkApplyUncertainError extends Error {
  readonly code = 'SINK_APPLY_UNCERTAIN';
  readonly sinkKey: string;

  constructor(sinkKey: string, detail: string) {
    super(`Synthetic stock sink gave no answer for ${sinkKey} (${detail}); the outcome is unknown`);
    this.name = 'SinkApplyUncertainError';
    this.sinkKey = sinkKey;
  }
}

/** Acquisition and size bounds must be whole numbers inside these limits. A NaN or infinite value cannot
 * end a wait, and the maxima keep a refusal recognisable rather than indistinguishable from a hang. */
export const sinkLedgerLimits = {
  lockWaitMs: { min: 0, max: 60_000, default: 2_000 },
  lockPollMs: { min: 1, max: 1_000, default: 10 },
  maxLedgerBytes: 8_388_608,
} as const;

function boundedMilliseconds(name: 'lockWaitMs' | 'lockPollMs', value: number): number {
  const { min, max } = sinkLedgerLimits[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number of milliseconds between ${min} and ${max}; received ${String(value)}`);
  }
  return value;
}

function boundedBytes(value: number): number {
  const max = sinkLedgerLimits.maxLedgerBytes;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`maxLedgerBytes must be a whole number of bytes between 1 and ${max}; received ${String(value)}`);
  }
  return value;
}

function emptyLedger(): SyntheticStockSinkLedger {
  return { version: 1, applyCalls: 0, receipts: {} };
}

/** Validates a parsed ledger before any decision is taken from it. A partially recognisable ledger is
 * treated as corrupt, because a silently dropped receipt reads exactly like a receipt that never existed. */
function assertLedger(path: string, value: unknown): SyntheticStockSinkLedger {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SinkLedgerCorruptError(path, 'not a JSON object');
  const ledger = value as Record<string, unknown>;
  if (ledger.version !== 1) throw new SinkLedgerCorruptError(path, `unsupported version ${JSON.stringify(ledger.version)}`);
  if (!Number.isSafeInteger(ledger.applyCalls) || (ledger.applyCalls as number) < 0) {
    throw new SinkLedgerCorruptError(path, 'applyCalls is not a counter');
  }
  if (typeof ledger.receipts !== 'object' || ledger.receipts === null || Array.isArray(ledger.receipts)) {
    throw new SinkLedgerCorruptError(path, 'receipts is not an object');
  }
  const receipts: Record<string, SyntheticStockReceipt> = {};
  for (const [key, entry] of Object.entries(ledger.receipts as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SinkLedgerCorruptError(path, `receipt ${key} is not an object`);
    const receipt = entry as Record<string, unknown>;
    try {
      assertSyntheticSinkKey(key);
      // Every stored receipt must still be self-consistent: the key, the payload hash and the derived
      // identities must agree, so a hand-edited ledger cannot become forged positive evidence.
      if (typeof receipt.payloadHash !== 'string' || typeof receipt.receiptToken !== 'string' || typeof receipt.stockReceiptId !== 'string') {
        throw new SinkLedgerCorruptError(path, `receipt ${key} is missing derived fields`);
      }
      if (receipt.sinkKey !== key) throw new SinkLedgerCorruptError(path, `receipt ${key} records a different key`);
      if (receipt.receiptToken !== syntheticStockReceiptToken(key, receipt.payloadHash)) {
        throw new SinkLedgerCorruptError(path, `receipt ${key} carries a token that does not match its payload hash`);
      }
      if (receipt.stockReceiptId !== derivedStockReceiptId(key)) throw new SinkLedgerCorruptError(path, `receipt ${key} carries an unexpected stock receipt identity`);
      if (!Array.isArray(receipt.lines) || receipt.lines.length === 0) throw new SinkLedgerCorruptError(path, `receipt ${key} has no lines`);
      if (receipt.lineCount !== receipt.lines.length) throw new SinkLedgerCorruptError(path, `receipt ${key} has a line count that does not match its lines`);
    } catch (error) {
      if (error instanceof SinkLedgerCorruptError) throw error;
      throw new SinkLedgerCorruptError(path, `receipt ${key} is not a valid stock receipt (${(error as Error).message})`);
    }
    receipts[key] = {
      sinkKey: key,
      stockReceiptId: receipt.stockReceiptId as string,
      payloadHash: receipt.payloadHash as string,
      receiptToken: receipt.receiptToken as string,
      lineCount: receipt.lineCount as number,
      lines: receipt.lines as readonly WritebackLine[],
    };
  }
  return { version: 1, applyCalls: ledger.applyCalls as number, receipts };
}

/** Derived so that two writers racing on one key cannot mint two stock receipt identities. */
function derivedStockReceiptId(sinkKey: string): string {
  return `syn-stock-${sinkKey.slice(sinkKey.lastIndexOf('-') + 1)}`;
}

export class SyntheticStockSink {
  readonly path: string;
  readonly mode: SyntheticStockSinkMode;
  readonly markerPath: string;
  readonly guaranteesIdempotentApply: boolean;
  readonly maxLedgerBytes: number;
  private readonly owner = randomUUID();
  private readonly lockWaitMs: number;
  private readonly lockPollMs: number;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(path: string, mode: SyntheticStockSinkMode = 'apply', options: SyntheticStockSinkOptions = {}) {
    // Everything is validated before anything touches the filesystem: an unusable bound is a
    // configuration fault, not a condition to discover part way through an acquisition.
    if (typeof path !== 'string' || path.trim() === '') throw new RangeError('A synthetic stock sink needs a non-empty ledger path');
    if (!syntheticStockSinkModes.includes(mode)) throw new RangeError(`mode must be one of ${syntheticStockSinkModes.join(', ')}; received ${String(mode)}`);
    if (options.idempotentApply !== undefined && typeof options.idempotentApply !== 'boolean') {
      throw new RangeError(`idempotentApply must be a boolean; received ${String(options.idempotentApply)}`);
    }
    this.lockWaitMs = boundedMilliseconds('lockWaitMs', options.lockWaitMs ?? sinkLedgerLimits.lockWaitMs.default);
    this.lockPollMs = boundedMilliseconds('lockPollMs', options.lockPollMs ?? sinkLedgerLimits.lockPollMs.default);
    this.maxLedgerBytes = boundedBytes(options.maxLedgerBytes ?? sinkLedgerLimits.maxLedgerBytes);
    this.guaranteesIdempotentApply = options.idempotentApply ?? false;
    this.path = path;
    this.mode = mode;
    this.markerPath = `${path}.lock`;
  }

  /** Exclusive-create is atomic for every independent instance and process sharing this ledger path.
   * A marker left by a crashed holder is never removed on age alone: the bounded wait ends in refusal,
   * so stale evidence survives for an operator decision instead of being silently taken over. */
  private async acquire(): Promise<void> {
    // Elapsed time is measured on the monotonic high-resolution clock, so changing the wall clock cannot
    // extend or shorten the bound. Wall-clock time is recorded in the marker for diagnosis only.
    const started = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
    await mkdir(dirname(this.path), { recursive: true });
    for (;;) {
      try {
        const handle = await open(this.markerPath, 'wx');
        let written = false;
        // Exclusive creation proves this marker is ours, so an unwritten one may be cleared here; that is
        // ownership, not a takeover, and it keeps a failed write from locking the ledger permanently.
        try {
          await handle.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid, acquiredAt: new Date().toISOString() } satisfies Marker));
          written = true;
        } finally {
          await handle.close();
          if (!written) await unlink(this.markerPath).catch(() => undefined);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const remainingMs = this.lockWaitMs - elapsedMs();
        if (remainingMs <= 0) throw new SinkLedgerLockError(this.markerPath, this.lockWaitMs);
        // The final sleep never overshoots the bound, so the total wait stays within it plus one attempt.
        await delay(Math.min(this.lockPollMs, remainingMs));
      }
    }
  }

  private async release(): Promise<void> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath, 'utf8')) as Partial<Marker>;
      // Only the recorded owner may clear the marker; a failure here leaves the ledger refused, never guessed.
      if (marker.owner === this.owner) await unlink(this.markerPath);
    } catch { /* a lost or unreadable marker is surfaced by the next bounded acquisition */ }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await action(); } finally { await this.release(); }
  }

  private async read(): Promise<SyntheticStockSinkLedger> {
    let bytes: number;
    try {
      bytes = (await stat(this.path)).size;
    } catch (error) {
      // Only a genuinely absent ledger is an empty one. Every other failure is surfaced.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
      throw error;
    }
    if (bytes > this.maxLedgerBytes) throw new SinkLedgerTooLargeError(this.path, bytes, this.maxLedgerBytes);
    const raw = await readFile(this.path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SinkLedgerCorruptError(this.path, `invalid JSON (${(error as Error).message})`);
    }
    return assertLedger(this.path, parsed);
  }

  /** A consistent snapshot: taken under the same exclusive access as a write, so a reader can never
   * observe a half-written ledger or block a concurrent replace. */
  async ledger(): Promise<SyntheticStockSinkLedger> {
    return this.serial.then(() => this.withLock(() => this.read()));
  }

  private change<T>(action: (ledger: SyntheticStockSinkLedger) => T): Promise<T> {
    const result = this.serial.then(() => this.withLock(async () => {
      const ledger = await this.read();
      const value = action(ledger);
      // Write to a unique temporary then rename: a reader under the same lock never sees a partial file,
      // and a crash mid-write leaves the previous ledger intact rather than a truncated one.
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, canonicalJson(ledger));
      await rename(temporary, this.path);
      return value;
    }));
    this.serial = result.catch(() => undefined);
    return result;
  }

  /** Records one stock receipt for this payload, or returns the one already recorded for its key.
   *
   * The payload is revalidated here rather than trusted. Deduplication is by derived key, so however many
   * instances or processes apply the same receipt, the ledger holds exactly one stock receipt for it. */
  async apply(payload: WritebackPayload): Promise<SyntheticStockReceipt> {
    const checked = assertWritebackPayload(payload);
    const sinkKey = syntheticSinkKey(checked);
    const payloadHash = writebackPayloadHash(checked);
    // A mode that never reaches the sink must not leave a ledger behind, so it is answered before any
    // filesystem access. The caller sees the same uncertainty as a post-apply disconnection.
    if (this.mode === 'unavailable') throw new SinkApplyUncertainError(sinkKey, 'the synthetic sink was unreachable');

    const recorded = await this.change((ledger) => {
      ledger.applyCalls += 1;
      const existing = ledger.receipts[sinkKey];
      if (existing) {
        // One key keeps one payload for its lifetime. A different payload means the durable receipt and
        // the sink disagree, and the recorded receipt is never replaced.
        if (existing.payloadHash !== payloadHash) throw new SinkReceiptConflictError(sinkKey, existing.payloadHash, payloadHash);
        return existing;
      }
      const receipt: SyntheticStockReceipt = {
        sinkKey,
        stockReceiptId: derivedStockReceiptId(sinkKey),
        payloadHash,
        receiptToken: syntheticStockReceiptToken(sinkKey, payloadHash),
        lineCount: checked.lines.length,
        lines: checked.lines,
      };
      ledger.receipts[sinkKey] = receipt;
      return receipt;
    });
    // Accepted, then the answer was lost. The receipt above is durable in the ledger, which is exactly the
    // uncertain outcome a reconciling lookup has to resolve.
    if (this.mode === 'timeout_after_apply') throw new SinkApplyUncertainError(sinkKey, 'the synthetic connection was lost after the sink accepted');
    return recorded;
  }

  /** Reads back whatever stock receipt this key holds. This is the only way an uncertain `apply` may be
   * settled, so it does the least possible: it is strictly read-only.
   *
   * It never creates, counts into or rewrites the ledger. That matters twice over. An absent ledger stays
   * absent, so "this sink was never reached" remains distinguishable from "this sink holds no receipt for
   * that key". And the one operation that has to work when everything else is uncertain cannot itself
   * fail on a write.
   *
   * `undefined` describes the sink at lookup time. It is not proof that an apply is not still in flight,
   * so it never authorises marking a writeback applied, and it only authorises a resend when the sink
   * explicitly advertises {@link guaranteesIdempotentApply}. */
  async lookup(sinkKey: string): Promise<SyntheticStockReceipt | undefined> {
    const key = assertSyntheticSinkKey(sinkKey);
    const ledger = await this.serial.then(() => this.withLock(() => this.read()));
    return ledger.receipts[key];
  }
}
