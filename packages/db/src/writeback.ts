import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type RuntimeClient, type TenantContext } from './runtime.ts';
import {
  assertWritebackPayload, syntheticSinkKey, syntheticStockReceiptToken, writebackPayloadHash, WritebackPayloadError,
  type WritebackPayload,
} from '../../writeback/src/payload.ts';
import {
  callWithDeadline, classifyApplyFailure, classifyLookupFailure, resolveWritebackProcessorOptions,
  type ResolvedWritebackProcessorOptions, type WritebackHoldReason, type WritebackProcessorOptions,
} from '../../writeback/src/processor-policy.ts';

/** Receipt writeback: delivering a confirmed receipt to a stock system at most once, and proving it arrived.
 *
 * `receipt_writeback.status` has two values and 'queued' means "not proven delivered". A writeback becomes
 * 'applied' only on positive sink evidence matching the exact payload recorded before sending. Every other
 * outcome leaves it queued, and all in-flight state lives in receipt_writeback_attempt (migration 0018).
 *
 * The rules this module is built on, each of which answers a defect found in review:
 *   1. No database transaction is ever held across a sink call.
 *   2. Every send is preceded by a lookup under the same claim, recorded durably as phase 'checking'. A
 *      restored or replayed row therefore never sends blindly, without any process-wide startup pass.
 *   3. A claim is identified by a token minted per claim, not per worker. Only the holder of the current
 *      token may move an attempt to a non-applied phase, so a stale "not found" can never demote or resend
 *      a live send, whether the competitor is another worker or a concurrent call in this one.
 *   4. A submitting or unanswered attempt is only ever settled by lookup. It is resent only when the sink
 *      explicitly guarantees idempotent apply, and even then through a fresh lookup first.
 *   5. Every sink call runs under a deadline shorter than its lease, every retry waits `retryDelayMs`, every
 *      attempt is counted and bounded, and every sink call is appended to receipt_writeback_attempt_log.
 *   6. Every transaction locks the writeback row before its attempt row, so settlements cannot deadlock
 *      against claims, and a database refusal is reported as a named outcome rather than thrown.
 *
 * BOUNDARY: 'applied' is delivery evidence only. It does NOT prove that any later inventory snapshot,
 * projection or watermark contains the stock. Nothing here records inclusion or touches replenishment
 * state; a separate inclusion writer owns that. See docs/receipt-writeback.md. */

export type WritebackPhase = 'pending' | 'checking' | 'submitting' | 'outcome_unknown' | 'needs_reconciliation' | 'applied';

/** What this module requires of a stock sink. Structural, so the database layer does not depend on the
 * synthetic implementation. `guaranteesIdempotentApply` is a promise the sink makes about itself.
 *
 * Error contract for `apply`: an error whose `code` is 'SINK_LEDGER_LOCKED' states nothing was recorded;
 * 'SINK_RECEIPT_CONFLICT', 'SINK_LEDGER_CORRUPT', 'SINK_LEDGER_TOO_LARGE' and 'WRITEBACK_PAYLOAD_INVALID'
 * are definite refusals; anything else, and any timeout, is treated as "may have been recorded". */
export type StockReceiptEvidence = { sinkKey: string; stockReceiptId: string; payloadHash: string; receiptToken: string; lineCount: number };
export type StockReceiptSink = {
  readonly guaranteesIdempotentApply: boolean;
  apply(payload: WritebackPayload): Promise<StockReceiptEvidence>;
  lookup(sinkKey: string): Promise<StockReceiptEvidence | undefined>;
};

export type WritebackScope = { subject: string; organisationId: string; branchId: string };

export type WritebackAppliedReason = 'applied_after_apply' | 'applied_found_by_lookup' | 'already_applied';
export type WritebackQueuedReason =
  | 'claimed_elsewhere'
  | 'claim_lost'
  | 'retry_not_due'
  | 'held_for_operator'
  | 'sink_ledger_locked'
  | 'lookup_inconclusive'
  | 'not_found_retry_permitted'
  | WritebackHoldReason;
export type WritebackRefusalReason = 'not_found' | 'invalid_writeback_id' | 'forbidden' | 'database_lock_timeout' | 'database_conflict';

export type WritebackOutcome =
  | { kind: 'applied'; writebackId: string; reason: WritebackAppliedReason; sinkReceiptToken: string | null; detail: string }
  | { kind: 'queued'; writebackId: string; phase: WritebackPhase; reason: WritebackQueuedReason; detail: string }
  | { kind: 'refused'; writebackId: string; reason: WritebackRefusalReason; detail: string };

export type WritebackRun =
  | { kind: 'completed'; outcomes: WritebackOutcome[] }
  | { kind: 'stopped'; reason: Exclude<WritebackRefusalReason, 'not_found' | 'invalid_writeback_id'>; detail: string; outcomes: WritebackOutcome[] };

/** Writeback completes a receipt confirmation, so it runs under the roles that may confirm a receipt. */
const writebackRoles: readonly string[] = ['pharmacy_owner', 'receiver'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A refusal raised inside a transaction so the transaction rolls back, then reported as an outcome. */
class Refusal extends Error {
  readonly reason: WritebackRefusalReason;
  constructor(reason: WritebackRefusalReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

function refusalOf(error: unknown): Refusal | undefined {
  if (error instanceof Refusal) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // lock_not_available: a bounded lock wait ran out. deadlock_detected / serialization_failure: the
  // database chose this transaction to abort. Each rolled back cleanly, so the durable state is intact.
  if (code === '55P03') return new Refusal('database_lock_timeout', message);
  if (code === '40P01' || code === '40001') return new Refusal('database_conflict', message);
  return undefined;
}

type LockedWriteback = { id: string; status: 'queued' | 'applied'; receiptId: string };
type Attempt = {
  phase: WritebackPhase; attempts: number; sinkKey: string; payloadHash: string | null; leaseToken: string | null;
  leaseLive: boolean; retryDue: boolean; sinkReceiptToken: string | null; holdReason: string | null;
};

/** Lock order is always writeback row, then attempt row. */
async function lockWriteback(client: RuntimeClient, writebackId: string): Promise<LockedWriteback | undefined> {
  return (await client.query(`SELECT id::text AS id,status,receipt_id::text AS "receiptId" FROM receipt_writeback WHERE id=$1 FOR UPDATE`, [writebackId])).rows[0];
}

async function lockAttempt(client: RuntimeClient, writebackId: string): Promise<Attempt | undefined> {
  return (await client.query(`SELECT phase,attempts,sink_key AS "sinkKey",payload_hash AS "payloadHash",lease_token::text AS "leaseToken",
      (lease_expires_at IS NOT NULL AND lease_expires_at>now()) AS "leaseLive",(not_before IS NULL OR not_before<=now()) AS "retryDue",
      sink_receipt_token AS "sinkReceiptToken",hold_reason AS "holdReason"
    FROM receipt_writeback_attempt WHERE writeback_id=$1 FOR UPDATE`, [writebackId])).rows[0];
}

type LogStep = { step: 'lookup' | 'apply' | 'decision'; result: string; reason: string; detail: string };

async function appendLog(client: RuntimeClient, context: TenantContext, writebackId: string, attempt: number, entry: LogStep) {
  await client.query(`INSERT INTO receipt_writeback_attempt_log(organisation_id,branch_id,writeback_id,attempt,step,result,reason,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7,left($8,1024))`,
  [context.organisationId, context.branchId, writebackId, attempt, entry.step, entry.result, entry.reason, entry.detail]);
}

type Built = { kind: 'built'; payload: WritebackPayload } | { kind: 'unbuildable'; detail: string };

/** Builds the payload from durable rows only. The quantity is exactly what the receiver confirmed; the need
 * and pack identity come only from the immutable order snapshot. Nothing is converted, inferred or taken
 * from a current product record. Anything that cannot be described exactly is reported, never repaired. */
async function buildPayload(client: RuntimeClient, context: TenantContext, writeback: LockedWriteback): Promise<Built> {
  const receipt = (await client.query(`SELECT id::text AS id,intent_id::text AS "intentId",reference,lines FROM receipt WHERE id=$1`, [writeback.receiptId])).rows[0];
  if (!receipt) return { kind: 'unbuildable', detail: `receipt ${writeback.receiptId} is not visible in this tenant scope` };
  const confirmed: unknown = receipt.lines;
  if (!Array.isArray(confirmed) || confirmed.length === 0) return { kind: 'unbuildable', detail: `receipt ${receipt.id} records no lines` };
  const snapshots = (await client.query(`SELECT id::text AS id,need_id::text AS "needId",product_snapshot AS "packIdentity" FROM order_line WHERE intent_id=$1`, [receipt.intentId])).rows as { id: string; needId: string; packIdentity: unknown }[];
  const byLine = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const lines: unknown[] = [];
  for (const entry of confirmed as unknown[]) {
    const line = typeof entry === 'object' && entry !== null ? entry as { lineId?: unknown; quantity?: unknown } : {};
    const snapshot = typeof line.lineId === 'string' ? byLine.get(line.lineId) : undefined;
    if (!snapshot) return { kind: 'unbuildable', detail: `receipt line ${JSON.stringify(line.lineId)} has no order snapshot to take its need and pack identity from` };
    lines.push({ lineId: line.lineId, needId: snapshot.needId, quantity: line.quantity, packIdentity: snapshot.packIdentity });
  }
  try {
    return { kind: 'built', payload: assertWritebackPayload({ writebackId: writeback.id, receiptId: receipt.id, intentId: receipt.intentId,
      organisationId: context.organisationId, branchId: context.branchId, reference: receipt.reference, lines }) };
  } catch (error) {
    if (error instanceof WritebackPayloadError) return { kind: 'unbuildable', detail: error.detail };
    throw error;
  }
}

type Claim = { kind: 'check' | 'recover'; writebackId: string; token: string; attempt: number; payload: WritebackPayload; sinkKey: string; payloadHash: string };
type Taken = { kind: 'claimed'; claim: Claim } | { kind: 'settled'; outcome: WritebackOutcome };

/** A state change only the current claim may make. `continue` keeps and extends the lease for a next step. */
type Transition =
  | { to: 'submitting'; from: 'checking' }
  | { to: 'outcome_unknown'; lease: 'retain' | 'release' }
  | { to: 'pending' }
  | { to: 'needs_reconciliation'; hold: WritebackHoldReason };

type Settled = { kind: 'continued' } | { kind: 'done'; outcome: WritebackOutcome };

function describeCurrent(writeback: LockedWriteback, attempt: Attempt | undefined, detail: string): WritebackOutcome {
  if (writeback.status === 'applied') {
    return { kind: 'applied', writebackId: writeback.id, reason: 'already_applied', sinkReceiptToken: attempt?.sinkReceiptToken ?? null, detail };
  }
  return { kind: 'queued', writebackId: writeback.id, phase: attempt?.phase ?? 'pending', reason: 'claim_lost', detail };
}

export class WritebackProcessor {
  readonly pool: Pool;
  readonly scope: WritebackScope;
  readonly sink: StockReceiptSink;
  readonly options: ResolvedWritebackProcessorOptions;

  constructor(pool: Pool, scope: WritebackScope, sink: StockReceiptSink, options: WritebackProcessorOptions = {}) {
    this.options = resolveWritebackProcessorOptions(options);
    if (typeof sink?.apply !== 'function' || typeof sink.lookup !== 'function' || typeof sink.guaranteesIdempotentApply !== 'boolean') {
      throw new TypeError('a stock receipt sink must provide apply, lookup and a boolean guaranteesIdempotentApply');
    }
    this.pool = pool;
    this.scope = scope;
    this.sink = sink;
  }

  private transaction<T>(callback: (client: RuntimeClient, context: TenantContext) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, this.scope.subject, this.scope.organisationId, this.scope.branchId, async (client, context) => {
      // A lock wait must end: a stuck peer becomes a reported refusal, not a hung worker.
      await client.query(`SET LOCAL lock_timeout='${this.options.lockTimeoutMs}ms'`);
      if (context.organisationKind !== 'pharmacy' || !writebackRoles.includes(context.role)) {
        throw new Refusal('forbidden', `role ${context.role} in a ${context.organisationKind} organisation may not write back receipts`);
      }
      return callback(client, context);
    });
  }

  /** Claims up to `batch` claimable writebacks and processes each at most once. Terminates whether or not
   * the queue is empty. A writeback the run cannot describe is held with a named reason, so one bad row
   * never blocks the rows behind it. */
  async runOnce(): Promise<WritebackRun> {
    const outcomes: WritebackOutcome[] = [];
    const seen: string[] = [];
    for (let processed = 0; processed < this.options.batch; processed += 1) {
      let taken: Taken | undefined;
      try {
        taken = await this.transaction(async (client, context) => {
          // SKIP LOCKED passes over a row another transaction is claiming or settling rather than waiting on it.
          const candidate = (await client.query(`SELECT w.id::text AS id FROM receipt_writeback w
              LEFT JOIN receipt_writeback_attempt a ON a.writeback_id=w.id
             WHERE w.status='queued' AND NOT (w.id=ANY($1::uuid[]))
               AND (a.writeback_id IS NULL OR (a.phase IN ('pending','checking','submitting','outcome_unknown')
                 AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=now())
                 AND (a.not_before IS NULL OR a.not_before<=now())))
             ORDER BY w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1`, [seen])).rows[0] as { id: string } | undefined;
          if (!candidate) return undefined;
          const writeback = await lockWriteback(client, candidate.id);
          if (!writeback) return undefined;
          return this.take(client, context, writeback);
        });
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === undefined || refusal.reason === 'not_found' || refusal.reason === 'invalid_writeback_id') throw error;
        return { kind: 'stopped', reason: refusal.reason, detail: refusal.message, outcomes };
      }
      if (!taken) break;
      const writebackId = taken.kind === 'claimed' ? taken.claim.writebackId : taken.outcome.writebackId;
      seen.push(writebackId);
      outcomes.push(taken.kind === 'settled' ? taken.outcome : await this.actReporting(taken.claim));
    }
    return { kind: 'completed', outcomes };
  }

  /** Processes one identified writeback end to end. */
  async process(writebackId: string): Promise<WritebackOutcome> {
    if (typeof writebackId !== 'string' || !uuidPattern.test(writebackId)) {
      return { kind: 'refused', writebackId: String(writebackId), reason: 'invalid_writeback_id', detail: 'a writeback id must be a lowercase canonical UUID' };
    }
    let taken: Taken;
    try {
      taken = await this.transaction(async (client, context) => {
        const writeback = await lockWriteback(client, writebackId);
        if (!writeback) throw new Refusal('not_found', `no receipt writeback ${writebackId} is visible in this tenant scope`);
        return this.take(client, context, writeback);
      });
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === undefined) throw error;
      return { kind: 'refused', writebackId, reason: refusal.reason, detail: refusal.message };
    }
    return taken.kind === 'settled' ? taken.outcome : this.actReporting(taken.claim);
  }

  /** Decides, under the writeback and attempt locks, whether this call may claim the writeback. */
  private async take(client: RuntimeClient, context: TenantContext, writeback: LockedWriteback): Promise<Taken> {
    const id = writeback.id;
    const prior = await lockAttempt(client, id);
    const settled = (outcome: WritebackOutcome): Taken => ({ kind: 'settled', outcome });
    if (writeback.status === 'applied') {
      return settled({ kind: 'applied', writebackId: id, reason: 'already_applied', sinkReceiptToken: prior?.sinkReceiptToken ?? null, detail: 'already proven delivered to the stock system' });
    }
    // A live claim is never disturbed, whoever holds it, including another call in this same worker.
    if (prior?.leaseLive) return settled({ kind: 'queued', writebackId: id, phase: prior.phase, reason: 'claimed_elsewhere', detail: 'another claim holds a live lease on this writeback' });
    if (prior?.phase === 'needs_reconciliation') {
      return settled({ kind: 'queued', writebackId: id, phase: prior.phase, reason: 'held_for_operator', detail: `held for an operator: ${prior.holdReason ?? 'no reason recorded'}` });
    }
    const sinkKey = syntheticSinkKey({ organisationId: context.organisationId, branchId: context.branchId, receiptId: writeback.receiptId });
    if (prior?.phase === 'applied') {
      return this.holdAtClaim(client, context, writeback, prior, sinkKey, null, 'attempt_status_disagree', 'the attempt records applied while the writeback is still queued');
    }
    if (prior && !prior.retryDue) return settled({ kind: 'queued', writebackId: id, phase: prior.phase, reason: 'retry_not_due', detail: 'the retry delay for this writeback has not passed' });
    const attempt = (prior?.attempts ?? 0) + 1;
    if (attempt > this.options.maxAttempts) {
      return this.holdAtClaim(client, context, writeback, prior, sinkKey, null, 'attempts_exhausted', `attempt ${attempt} would exceed the bound of ${this.options.maxAttempts}; refusing to try again`);
    }
    const built = await buildPayload(client, context, writeback);
    if (built.kind === 'unbuildable') return this.holdAtClaim(client, context, writeback, prior, sinkKey, null, 'payload_unbuildable', built.detail);
    const payloadHash = writebackPayloadHash(built.payload);
    if (prior && prior.payloadHash !== payloadHash) {
      return this.holdAtClaim(client, context, writeback, prior, sinkKey, payloadHash, 'payload_changed',
        `the receipt payload hash changed from ${String(prior.payloadHash)} to ${payloadHash} since the attempt was recorded`);
    }
    if (prior && prior.sinkKey !== sinkKey) {
      return this.holdAtClaim(client, context, writeback, prior, sinkKey, payloadHash, 'sink_key_changed', `the stock receipt key changed from ${prior.sinkKey} to ${sinkKey}`);
    }
    // 'submitting' or 'outcome_unknown' may have sent, so only a lookup may follow. 'pending', 'checking' or
    // no attempt at all provably sent nothing, so a lookup and then a send may follow.
    const recover = prior?.phase === 'submitting' || prior?.phase === 'outcome_unknown';
    const token = randomUUID();
    await client.query(`INSERT INTO receipt_writeback_attempt(writeback_id,organisation_id,branch_id,sink_key,payload_hash,phase,attempts,lease_token,lease_expires_at,last_reason,last_detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid,now()+$9::integer*interval '1 millisecond',$10,$11)
      ON CONFLICT(writeback_id) DO UPDATE SET phase=EXCLUDED.phase,attempts=EXCLUDED.attempts,lease_token=EXCLUDED.lease_token,
        lease_expires_at=EXCLUDED.lease_expires_at,not_before=NULL,last_reason=EXCLUDED.last_reason,last_detail=EXCLUDED.last_detail,updated_at=now()`,
    [id, context.organisationId, context.branchId, sinkKey, payloadHash, recover ? 'outcome_unknown' : 'checking', attempt, token, this.options.leaseMs,
      recover ? 'claimed_for_recovery' : 'claimed_for_check', recover ? `recovering an unsettled attempt from phase ${String(prior?.phase)}` : 'claimed to look up before any send']);
    return { kind: 'claimed', claim: { kind: recover ? 'recover' : 'check', writebackId: id, token, attempt, payload: built.payload, sinkKey, payloadHash } };
  }

  /** Holds a writeback for an operator from inside the claim transaction. No sink call was made. */
  private async holdAtClaim(client: RuntimeClient, context: TenantContext, writeback: LockedWriteback, prior: Attempt | undefined,
    sinkKey: string, payloadHash: string | null, hold: WritebackHoldReason, detail: string): Promise<Taken> {
    const attempts = prior?.attempts ?? 0;
    await client.query(`INSERT INTO receipt_writeback_attempt(writeback_id,organisation_id,branch_id,sink_key,payload_hash,phase,attempts,hold_reason,last_reason,last_detail)
      VALUES($1,$2,$3,$4,$5,'needs_reconciliation',$6,$7,$7,left($8,1024))
      ON CONFLICT(writeback_id) DO UPDATE SET phase='needs_reconciliation',lease_token=NULL,lease_expires_at=NULL,not_before=NULL,
        hold_reason=EXCLUDED.hold_reason,last_reason=EXCLUDED.last_reason,last_detail=EXCLUDED.last_detail,updated_at=now()`,
    [writeback.id, context.organisationId, context.branchId, prior?.sinkKey ?? sinkKey, prior?.payloadHash ?? payloadHash, attempts, hold, detail]);
    await appendLog(client, context, writeback.id, attempts, { step: 'decision', result: 'held', reason: hold, detail });
    return { kind: 'settled', outcome: { kind: 'queued', writebackId: writeback.id, phase: 'needs_reconciliation', reason: hold, detail } };
  }

  /** Runs a claim, reporting a database refusal while settling as an outcome. The transaction that failed
   * rolled back, so the attempt is left in the phase it last committed, which never under-states a send. */
  private async actReporting(claim: Claim): Promise<WritebackOutcome> {
    try {
      return await this.act(claim);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === undefined) throw error;
      return { kind: 'refused', writebackId: claim.writebackId, reason: refusal.reason, detail: refusal.message };
    }
  }

  /** The only place the sink is called. No transaction is open during any call. */
  private async act(claim: Claim): Promise<WritebackOutcome> {
    if (claim.kind === 'recover') return this.recover(claim);
    const looked = await callWithDeadline(() => this.sink.lookup(claim.sinkKey), this.options.sinkCallTimeoutMs);
    if (looked.kind !== 'answered') {
      // Nothing has been sent by this claim, so an unanswered pre-send lookup simply releases it.
      const failure = classifyLookupFailure(looked);
      return this.finish(await this.settle(claim, { to: 'pending' }, { step: 'lookup', result: 'inconclusive', reason: failure.reason, detail: failure.detail }, 'lookup_inconclusive'));
    }
    if (looked.value) return this.recordEvidence(claim, looked.value, 'lookup');
    const moved = await this.settle(claim, { to: 'submitting', from: 'checking' },
      { step: 'lookup', result: 'not_found', reason: 'lookup_not_found_before_send', detail: 'the sink holds no receipt for this key; committing the intent to send' }, 'lookup_inconclusive');
    // Only the claim that committed 'submitting' may send. A claim that lost its lease sends nothing.
    if (moved.kind === 'done') return moved.outcome;

    const applied = await callWithDeadline(() => this.sink.apply(claim.payload), this.options.sinkCallTimeoutMs);
    if (applied.kind === 'answered') return this.recordEvidence(claim, applied.value, 'apply');
    const failure = classifyApplyFailure(applied);
    if (failure.kind === 'not_recorded') {
      return this.finish(await this.settle(claim, { to: 'pending' }, { step: 'apply', result: 'not_recorded', reason: failure.reason, detail: failure.detail }, 'sink_ledger_locked'));
    }
    if (failure.kind === 'refused') {
      return this.finish(await this.settle(claim, { to: 'needs_reconciliation', hold: failure.reason }, { step: 'apply', result: 'refused', reason: failure.reason, detail: failure.detail }, failure.reason));
    }
    // No answer: the sink may have recorded it. Commit that fact, keeping the lease, then settle by lookup.
    const unknown = await this.settle(claim, { to: 'outcome_unknown', lease: 'retain' }, { step: 'apply', result: 'no_answer', reason: failure.reason, detail: failure.detail }, 'lookup_inconclusive');
    if (unknown.kind === 'done') return unknown.outcome;
    return this.recover(claim);
  }

  /** Settles an attempt that may have sent. Looks up; never sends. */
  private async recover(claim: Claim): Promise<WritebackOutcome> {
    const looked = await callWithDeadline(() => this.sink.lookup(claim.sinkKey), this.options.sinkCallTimeoutMs);
    if (looked.kind !== 'answered') {
      const failure = classifyLookupFailure(looked);
      return this.finish(await this.settle(claim, { to: 'outcome_unknown', lease: 'release' }, { step: 'lookup', result: 'inconclusive', reason: failure.reason, detail: failure.detail }, 'lookup_inconclusive'));
    }
    if (looked.value) return this.recordEvidence(claim, looked.value, 'lookup');
    // "Not found" describes the sink at lookup time; it is not proof no send is in flight. It permits a
    // further attempt only when the sink guarantees repeating an apply is safe, and that attempt still
    // looks up first. Otherwise resending risks a duplicate stock receipt: an operator decides.
    if (this.sink.guaranteesIdempotentApply) {
      return this.finish(await this.settle(claim, { to: 'pending' },
        { step: 'lookup', result: 'not_found', reason: 'not_found_retry_permitted', detail: 'the sink guarantees idempotent apply and holds no receipt for this key' }, 'not_found_retry_permitted'));
    }
    return this.finish(await this.settle(claim, { to: 'needs_reconciliation', hold: 'not_found_without_idempotency' },
      { step: 'lookup', result: 'not_found', reason: 'not_found_without_idempotency', detail: 'the sink holds no receipt for this key and does not guarantee idempotent apply; refusing to resend' }, 'not_found_without_idempotency'));
  }

  private finish(settled: Settled): WritebackOutcome {
    if (settled.kind === 'done') return settled.outcome;
    throw new Error('a terminal writeback transition unexpectedly continued');
  }

  /** Records one sink call and applies a transition only if this claim still holds the lease. The call is
   * logged either way: every sink call is evidence, including one made by a claim that was overtaken. */
  private async settle(claim: Claim, transition: Transition, entry: LogStep, reason: WritebackQueuedReason): Promise<Settled> {
    return this.transaction(async (client, context) => {
      const writeback = await lockWriteback(client, claim.writebackId);
      if (!writeback) throw new Refusal('not_found', `receipt writeback ${claim.writebackId} is no longer visible in this tenant scope`);
      const attempt = await lockAttempt(client, claim.writebackId);
      await appendLog(client, context, claim.writebackId, attempt?.attempts ?? claim.attempt, entry);
      const owns = attempt !== undefined && attempt.leaseToken === claim.token && writeback.status === 'queued'
        && (!('from' in transition) || attempt.phase === transition.from);
      if (!owns) return { kind: 'done', outcome: describeCurrent(writeback, attempt, 'this claim no longer holds the lease; nothing was changed') };

      const retryMs = this.options.retryDelayMs;
      const leaseMs = this.options.leaseMs;
      const detail = entry.detail;
      if (transition.to === 'submitting' || (transition.to === 'outcome_unknown' && transition.lease === 'retain')) {
        await client.query(`UPDATE receipt_writeback_attempt SET phase=$2,lease_expires_at=now()+$3::integer*interval '1 millisecond',
            last_reason=$4,last_detail=left($5,1024),updated_at=now() WHERE writeback_id=$1`,
        [claim.writebackId, transition.to, leaseMs, entry.reason, detail]);
        return { kind: 'continued' };
      }
      if (transition.to === 'needs_reconciliation') {
        await client.query(`UPDATE receipt_writeback_attempt SET phase='needs_reconciliation',lease_token=NULL,lease_expires_at=NULL,not_before=NULL,
            hold_reason=$2,last_reason=$2,last_detail=left($3,1024),updated_at=now() WHERE writeback_id=$1`,
        [claim.writebackId, transition.hold, detail]);
        return { kind: 'done', outcome: { kind: 'queued', writebackId: claim.writebackId, phase: 'needs_reconciliation', reason: transition.hold, detail } };
      }
      await client.query(`UPDATE receipt_writeback_attempt SET phase=$2,lease_token=NULL,lease_expires_at=NULL,
          not_before=now()+$3::integer*interval '1 millisecond',last_reason=$4,last_detail=left($5,1024),updated_at=now() WHERE writeback_id=$1`,
      [claim.writebackId, transition.to, retryMs, entry.reason, detail]);
      return { kind: 'done', outcome: { kind: 'queued', writebackId: claim.writebackId, phase: transition.to, reason, detail } };
    });
  }

  /** Marks the writeback applied, and only on positive evidence matching this exact receipt.
   *
   * Positive matching evidence is authoritative whoever holds the lease: a send that was already under way
   * when its claim was overtaken still proves delivery, so it is recorded rather than discarded. Every
   * negative consequence of evidence (a hold) is still reserved to the current claim. */
  private async recordEvidence(claim: Claim, evidence: StockReceiptEvidence, step: 'lookup' | 'apply'): Promise<WritebackOutcome> {
    const expected = syntheticStockReceiptToken(claim.sinkKey, claim.payloadHash);
    const matches = evidence.sinkKey === claim.sinkKey && evidence.payloadHash === claim.payloadHash
      && evidence.receiptToken === expected && evidence.lineCount === claim.payload.lines.length;
    const result = step === 'lookup' ? 'found' : 'acknowledged';
    const reason: WritebackAppliedReason = step === 'lookup' ? 'applied_found_by_lookup' : 'applied_after_apply';
    return this.transaction(async (client, context) => {
      const writeback = await lockWriteback(client, claim.writebackId);
      if (!writeback) throw new Refusal('not_found', `receipt writeback ${claim.writebackId} is no longer visible in this tenant scope`);
      const attempt = await lockAttempt(client, claim.writebackId);
      const logAttempt = attempt?.attempts ?? claim.attempt;
      const owns = attempt !== undefined && attempt.leaseToken === claim.token;
      const log = (logReason: string, detail: string) => appendLog(client, context, claim.writebackId, logAttempt, { step, result, reason: logReason, detail });
      const hold = async (holdReason: WritebackHoldReason, detail: string): Promise<WritebackOutcome> => {
        await log(holdReason, detail);
        if (!owns) return describeCurrent(writeback, attempt, `${detail}; this claim no longer holds the lease, so nothing was changed`);
        await client.query(`UPDATE receipt_writeback_attempt SET phase='needs_reconciliation',lease_token=NULL,lease_expires_at=NULL,not_before=NULL,
            hold_reason=$2,last_reason=$2,last_detail=left($3,1024),updated_at=now() WHERE writeback_id=$1`, [claim.writebackId, holdReason, detail]);
        return { kind: 'queued', writebackId: claim.writebackId, phase: 'needs_reconciliation', reason: holdReason, detail };
      };

      if (!matches) {
        return hold('evidence_mismatch', `the sink returned evidence that does not match this receipt (key ${String(evidence.sinkKey)}, payload ${String(evidence.payloadHash)}, ${String(evidence.lineCount)} lines)`);
      }
      if (writeback.status === 'applied') {
        await log('already_applied', 'the writeback was already recorded as delivered');
        return { kind: 'applied', writebackId: claim.writebackId, reason: 'already_applied', sinkReceiptToken: attempt?.sinkReceiptToken ?? expected, detail: 'already proven delivered to the stock system' };
      }
      // The payload is re-derived under lock. If the receipt changed while the sink was being called, the
      // evidence describes something else and must not be recorded.
      const rebuilt = await buildPayload(client, context, writeback);
      if (rebuilt.kind === 'unbuildable' || writebackPayloadHash(rebuilt.payload) !== claim.payloadHash) {
        return hold('receipt_changed_during_call', 'the receipt changed while the sink was being called; refusing to record the evidence');
      }
      if (!attempt || attempt.payloadHash !== claim.payloadHash || attempt.sinkKey !== claim.sinkKey) {
        await log('claim_lost', 'the recorded attempt no longer describes this payload');
        return describeCurrent(writeback, attempt, 'the recorded attempt no longer describes this payload; nothing was changed');
      }
      // The queued-to-applied transition is the serialisation point: exactly one transaction records it.
      await client.query(`UPDATE receipt_writeback SET status='applied' WHERE id=$1 AND status='queued'`, [claim.writebackId]);
      const detail = step === 'lookup' ? 'a sink lookup found the recorded stock receipt' : 'the sink acknowledged the apply';
      await client.query(`UPDATE receipt_writeback_attempt SET phase='applied',sink_receipt_token=$2,lease_token=NULL,lease_expires_at=NULL,not_before=NULL,
          hold_reason=NULL,last_reason=$3,last_detail=$4,updated_at=now() WHERE writeback_id=$1`, [claim.writebackId, expected, reason, detail]);
      await log(reason, detail);
      // Nothing else is touched: no need, inventory, alert or inclusion state. Delivery is not inclusion.
      return { kind: 'applied', writebackId: claim.writebackId, reason, sinkReceiptToken: expected, detail };
    });
  }
}
