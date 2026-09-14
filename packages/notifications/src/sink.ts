import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isStrictInstant } from './instant.ts';
import { inspectDeliveryPayload, type SafeDeliveryPayload } from './payload.ts';

/**
 * The record of what actually left the system, kept outside the database on purpose.
 *
 * A sink that accepts a notification and then loses the connection leaves the caller unable to tell
 * acceptance from failure. The only safe resolution is to ask the sink what it already has, so the
 * sink - not the database - owns the delivery identity and answers `lookup` for it. That is the same
 * discipline the order path uses for a supplier that accepts and then times out.
 */
export type DeliveryReceipt = Readonly<{
  deliveryId: string;
  receiptId: string;
  acceptedAt: string;
}>;

export type SinkLedger = Readonly<{
  deliverCalls: number;
  lookupCalls: number;
  receipts: Readonly<Record<string, DeliveryReceipt>>;
}>;

/**
 * `kind` is not decoration. A dispatcher refuses a synthetic sink unless the caller acknowledged it
 * explicitly, so the development adapter cannot become a deployment default by being the only one
 * wired up.
 */
export interface DeliverySink {
  readonly kind: 'synthetic' | 'external';
  deliver(deliveryId: string, payload: SafeDeliveryPayload): Promise<DeliveryReceipt>;
  lookup(deliveryId: string): Promise<DeliveryReceipt | undefined>;
}

export type SyntheticSinkMode = 'delivered' | 'timeout_after_accept' | 'unavailable';

export type SyntheticSinkOptions = {
  path: string;
  /** Injected: the sink never reads the server clock, so quiet-hours evidence stays reproducible. */
  clock: () => string;
  mode?: SyntheticSinkMode;
  lockWaitMs?: number;
  lockPollMs?: number;
  maxReceipts?: number;
  maxPayloadBytes?: number;
};

export type SinkViolation =
  | 'identifier_not_opaque'
  | 'payload_shape'
  | 'payload_too_large'
  | 'ledger_capacity_exceeded'
  | 'invalid_clock';

/**
 * Raised when exclusive ledger access cannot be obtained within the bound. The caller must treat the
 * outcome as unknown; it must never assume the ledger is empty or safe to overwrite.
 */
export class DeliverySinkLockError extends Error {
  readonly code = 'SINK_LEDGER_LOCKED';
  readonly markerPath: string;

  constructor(markerPath: string, waitedMs: number) {
    super(`Synthetic delivery ledger remained locked for ${waitedMs}ms; refusing to read or write it`);
    this.name = 'DeliverySinkLockError';
    this.markerPath = markerPath;
  }
}

/** A malformed request the sink can prove it never accepted. Retrying it unchanged is pointless. */
export class DeliverySinkRefusedError extends Error {
  readonly code = 'SINK_REFUSED';
  readonly violation: SinkViolation;

  constructor(violation: SinkViolation, detail: string) {
    super(`Synthetic delivery refused: ${violation} (${detail})`);
    this.name = 'DeliverySinkRefusedError';
    this.violation = violation;
  }
}

/** Accepted, then the connection was lost. The delivery exists; only the answer was lost. */
export class DeliverySinkTimeoutError extends Error {
  readonly code = 'SINK_OUTCOME_UNKNOWN';

  constructor(deliveryId: string) {
    super(`Synthetic delivery connection lost after acceptance for ${deliveryId}`);
    this.name = 'DeliverySinkTimeoutError';
  }
}

/** The channel was not reached. It still proves nothing: only a lookup can settle the outcome. */
export class DeliverySinkUnavailableError extends Error {
  readonly code = 'SINK_UNAVAILABLE';

  constructor(deliveryId: string) {
    super(`Synthetic delivery channel is unavailable for ${deliveryId}`);
    this.name = 'DeliverySinkUnavailableError';
  }
}

/**
 * Acquisition and capacity bounds must be whole numbers inside these limits. A NaN or infinite bound
 * cannot end a wait, and the maxima keep a refusal recognisable rather than indistinguishable from a
 * hang or from a disk filling up.
 */
const bounds = {
  lockWaitMs: { min: 0, max: 60_000 },
  lockPollMs: { min: 1, max: 1_000 },
  maxReceipts: { min: 1, max: 1_000_000 },
  maxPayloadBytes: { min: 1, max: 65_536 },
} as const;

function boundedInteger(name: keyof typeof bounds, value: number): number {
  const { min, max } = bounds[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number between ${min} and ${max}; received ${String(value)}`);
  }
  return value;
}

const opaqueIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether an exclusive create failed because another holder has the marker. On Windows a create that
 * races the previous holder's unlink reports EPERM rather than EEXIST. It is waited out inside the same
 * bound, so a directory that is genuinely not writable still ends in a bounded refusal, never a hang.
 */
function markerContended(code: string | undefined): boolean {
  return code === 'EEXIST' || (process.platform === 'win32' && code === 'EPERM');
}

type Marker = { owner: string; pid: number; acquiredAt: string };
type MutableLedger = { deliverCalls: number; lookupCalls: number; receipts: Record<string, DeliveryReceipt> };

/**
 * A file-backed delivery sink for development and tests. It is not a notification channel: nothing
 * here reaches a device, a push service, an inbox or a phone number, and it must never be wired into
 * a deployment as the delivery adapter.
 *
 * What it does model faithfully is the part that makes delivery hard: an identity the sink owns, an
 * idempotent accept, a lookup that survives a restart of this process, and an acceptance whose
 * answer can be lost.
 */
export class SyntheticFileDeliverySink implements DeliverySink {
  readonly kind = 'synthetic' as const;
  readonly path: string;
  readonly markerPath: string;
  readonly mode: SyntheticSinkMode;
  private readonly clock: () => string;
  private readonly owner = randomUUID();
  private readonly lockWaitMs: number;
  private readonly lockPollMs: number;
  private readonly maxReceipts: number;
  private readonly maxPayloadBytes: number;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(options: SyntheticSinkOptions) {
    if (typeof options?.path !== 'string' || options.path.trim() === '') {
      throw new TypeError('A synthetic delivery sink requires a ledger path');
    }
    if (typeof options.clock !== 'function') {
      throw new TypeError('A synthetic delivery sink requires an injected clock');
    }
    // Validated before anything touches the filesystem: an unusable bound is a configuration fault,
    // not a condition to discover part way through an acquisition.
    this.lockWaitMs = boundedInteger('lockWaitMs', options.lockWaitMs ?? 2_000);
    this.lockPollMs = boundedInteger('lockPollMs', options.lockPollMs ?? 10);
    this.maxReceipts = boundedInteger('maxReceipts', options.maxReceipts ?? 100_000);
    this.maxPayloadBytes = boundedInteger('maxPayloadBytes', options.maxPayloadBytes ?? 4_096);
    this.path = options.path;
    this.markerPath = `${options.path}.lock`;
    this.mode = options.mode ?? 'delivered';
    this.clock = options.clock;
  }

  /**
   * Exclusive-create is atomic for every independent instance and process sharing this ledger path.
   * A marker left by a crashed holder is never removed on age alone: the bounded wait ends in a
   * refusal, so the evidence survives for an operator decision instead of being silently taken over.
   */
  private async acquire(): Promise<void> {
    // Elapsed time is measured on the monotonic high-resolution clock, so moving the wall clock -
    // or injecting a frozen one - cannot extend or shorten the bound.
    const started = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
    await mkdir(dirname(this.path), { recursive: true });
    for (;;) {
      try {
        const handle = await open(this.markerPath, 'wx');
        let written = false;
        // Exclusive creation proves this marker is ours, so an unwritten one may be cleared here;
        // that is ownership, not a takeover, and it keeps a failed write from locking it forever.
        try {
          const marker: Marker = { owner: this.owner, pid: process.pid, acquiredAt: this.stampOrEpoch() };
          await handle.writeFile(JSON.stringify(marker));
          written = true;
        } finally {
          await handle.close();
          if (!written) await unlink(this.markerPath).catch(() => undefined);
        }
        return;
      } catch (error) {
        if (!markerContended((error as NodeJS.ErrnoException).code)) throw error;
        const remainingMs = this.lockWaitMs - elapsedMs();
        if (remainingMs <= 0) throw new DeliverySinkLockError(this.markerPath, this.lockWaitMs);
        // The final sleep never overshoots the bound, so the wait stays within it plus one attempt.
        await delay(Math.min(this.lockPollMs, remainingMs));
      }
    }
  }

  private async release(): Promise<void> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath, 'utf8')) as Partial<Marker>;
      // Only the recorded owner may clear the marker; a failure here leaves the ledger refused.
      if (marker.owner === this.owner) await unlink(this.markerPath);
    } catch { /* a lost or unreadable marker is surfaced by the next bounded acquisition */ }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await action(); } finally { await this.release(); }
  }

  private async read(): Promise<MutableLedger> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as MutableLedger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deliverCalls: 0, lookupCalls: 0, receipts: {} };
      throw error;
    }
  }

  private change<T>(action: (ledger: MutableLedger) => T): Promise<T> {
    const result = this.serial.then(() => this.withLock(async () => {
      const ledger = await this.read();
      const value = action(ledger);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(ledger));
      await rename(temporary, this.path);
      return value;
    }));
    this.serial = result.catch(() => undefined);
    return result;
  }

  /** Diagnostic only, and never used for a delivery decision. */
  private stampOrEpoch(): string {
    const stamped = this.safeClock();
    return stamped ?? new Date(0).toISOString();
  }

  private safeClock(): string | null {
    try {
      const value = this.clock();
      return typeof value === 'string' && isStrictInstant(value) ? value : null;
    } catch {
      return null;
    }
  }

  private requireOpaque(deliveryId: string): string {
    if (typeof deliveryId !== 'string' || !opaqueIdentifier.test(deliveryId)) {
      // A readable or relative identifier is refused before it can reach a key or a path.
      throw new DeliverySinkRefusedError('identifier_not_opaque', 'deliveryId');
    }
    return deliveryId;
  }

  /**
   * A consistent snapshot: taken under the same exclusive access as a write, so a reader can never
   * observe a half-written ledger. It counts as neither a delivery nor a lookup.
   */
  async ledger(): Promise<SinkLedger> {
    return this.serial.then(() => this.withLock(() => this.read()));
  }

  async deliver(deliveryId: string, payload: SafeDeliveryPayload): Promise<DeliveryReceipt> {
    const id = this.requireOpaque(deliveryId);
    const violation = inspectDeliveryPayload(payload);
    if (violation !== null) throw new DeliverySinkRefusedError('payload_shape', violation);
    const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (size > this.maxPayloadBytes) {
      throw new DeliverySinkRefusedError('payload_too_large', `${size} bytes`);
    }
    const acceptedAt = this.safeClock();
    if (acceptedAt === null) throw new DeliverySinkRefusedError('invalid_clock', 'clock did not return an instant');
    // An unreachable channel is refused before the ledger is touched, so nothing was accepted. The
    // caller still cannot conclude non-delivery for an identifier it has sent before: only a lookup
    // settles that, which is why the dispatcher resolves every send failure the same way.
    if (this.mode === 'unavailable') throw new DeliverySinkUnavailableError(id);

    const receipt = await this.change((ledger) => {
      ledger.deliverCalls += 1;
      if (!Object.hasOwn(ledger.receipts, id)) {
        if (Object.keys(ledger.receipts).length >= this.maxReceipts) {
          // Refusing keeps the file bounded. Identifiers already recorded still resolve, so capacity
          // can never force a duplicate notification.
          throw new DeliverySinkRefusedError('ledger_capacity_exceeded', `${this.maxReceipts} receipts`);
        }
        // The freshest ledger is read under exclusive access, so one identifier keeps one receipt
        // however many independent instances or processes deliver it.
        ledger.receipts[id] = Object.freeze({ deliveryId: id, receiptId: `syn-${randomUUID()}`, acceptedAt });
      }
      return ledger.receipts[id]!;
    });

    if (this.mode === 'timeout_after_accept') throw new DeliverySinkTimeoutError(id);
    return receipt;
  }

  async lookup(deliveryId: string): Promise<DeliveryReceipt | undefined> {
    const id = this.requireOpaque(deliveryId);
    return this.change((ledger) => {
      ledger.lookupCalls += 1;
      return Object.hasOwn(ledger.receipts, id) ? ledger.receipts[id] : undefined;
    });
  }
}
