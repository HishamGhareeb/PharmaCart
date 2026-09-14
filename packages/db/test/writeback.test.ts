import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { FakeSupplier } from '../../supplier/src/fake.ts';
import { SyntheticStockSink } from '../../writeback/src/sink.ts';
import { syntheticSinkKey, syntheticStockReceiptToken, type WritebackPayload } from '../../writeback/src/payload.ts';
import { IntentWorker, confirmReceipt } from '../src/orders.ts';
import { WritebackProcessor, type StockReceiptEvidence, type StockReceiptSink, type WritebackOutcome } from '../src/writeback.ts';
import { createQuote, approveQuote } from '../src/procurement.ts';
import { withTransaction, createRuntimePool } from '../src/runtime.ts';
import { configureRuntimeLogin } from '../scripts/runtime-setup.mjs';
import { ids, sql, resetDatabase } from './support.ts';
import { seedProcurement } from './procurement-fixture.ts';

// Receipt writeback against PostgreSQL. Requires migration 0018_writeback_attempts.sql, which the
// coordinator applies through resetDatabase(). Written before the processor was corrected and not run by
// its author: no result in this file is evidence until the coordinator has run it.
//
// `receipt_writeback.status` has two values and 'queued' means "not proven delivered". Each test below is a
// way that meaning, or the at-most-once delivery behind it, could break: two claims acting at once, a worker
// dying mid-send, an unanswered or hung sink, a lookup that cannot answer, a retry loop that never waits, a
// poison row, a settlement that fails part way, another tenant's rows, or a restore. The independent
// file-backed sink is the evidence for what was actually delivered.
//
// Every assertion about 'applied' is about delivery only. An applied writeback does not prove any inventory
// snapshot contains the stock, and the inclusion columns must stay NULL throughout.

const scopeA = { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA };
const scopeB = { subject: 'synthetic:user:b', organisationId: ids.b, branchId: ids.branchB };
const ownerC = { id: '30000000-0000-4000-8000-000000000003', subject: 'synthetic:user:c' };

type Pool = Awaited<ReturnType<typeof resetDatabase>>;

async function preconditions() {
  const applied = (await sql(`SELECT count(*) FROM schema_migration WHERE version='0018_writeback_attempts.sql'`)).trim();
  assert.equal(applied, '1', 'migration 0018_writeback_attempts.sql must be applied before these tests can run');
}

async function arrange(t: TestContext) {
  const pool = await resetDatabase();
  t.after(async () => { if (!pool.ending) await pool.end(); });
  const directory = await mkdtemp(join(process.cwd(), 'tmp-writeback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await preconditions();
  return { pool, directory, path: join(directory, 'stock', 'sink.json') };
}

/** Drives the established synthetic loop to confirmed receipts and their queued writebacks. Nothing here
 * writes receipt, receipt_writeback or order_line directly. The order ships two boxes, so up to two
 * one-box receipts can be confirmed against it. */
async function seedReceipts(pool: Pool, directory: string, references: readonly string[] = ['receipt-wb-1']) {
  const transaction = <T>(callback: Parameters<typeof withTransaction<T>>[4]) =>
    withTransaction(pool, scopeA.subject, scopeA.organisationId, scopeA.branchId, callback);
  await seedProcurement();
  const supplier = new FakeSupplier(join(directory, 'supplier.json'), 'accepted');
  const quote = await transaction((c, x) => createQuote(c, x, { branchId: ids.branchA, lines: [{ needId: ids.needA, needVersion: 1, quantity: '2', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } }));
  const approval = await transaction((c, x) => approveQuote(c, x, quote.id, 1, 'writeback-test'));
  const intentId = approval.body.orderIntentIds[0]!;
  const worker = new IntentWorker(pool, scopeA, supplier);
  await worker.enableSyntheticDispatch();
  assert.equal((await worker.run(intentId)).state, 'acknowledged');
  const lineId = (await sql('SELECT id FROM order_line')).trim();
  const receipts: { reference: string; receiptId: string; writebackId: string }[] = [];
  for (const reference of references) {
    const receipt = await transaction((c, x) => confirmReceipt(c, x, intentId, reference, [{ lineId, quantity: '1' }]));
    const writebackId = (await sql(`SELECT id FROM receipt_writeback WHERE receipt_id='${receipt.id}'`)).trim();
    assert.equal((await sql(`SELECT status FROM receipt_writeback WHERE id='${writebackId}'`)).trim(), 'queued');
    receipts.push({ reference, receiptId: receipt.id, writebackId });
  }
  return { transaction, intentId, lineId, receipts, writebackId: receipts[0]!.writebackId, receiptId: receipts[0]!.receiptId };
}

/** Durable state as one comparable string: status|phase|attempts|lease|hold|token|inclusion-unrecorded. */
async function state(writebackId: string) {
  const row = (await sql(`SELECT w.status||'|'||coalesce(a.phase,'-')||'|'||coalesce(a.attempts::text,'-')||'|'||
      CASE WHEN a.lease_token IS NULL THEN '-' ELSE 'leased' END||'|'||coalesce(a.hold_reason,'-')||'|'||
      CASE WHEN a.sink_receipt_token IS NULL THEN '-' ELSE 'token' END||'|'||
      (w.included_snapshot_id IS NULL AND w.included_sequence IS NULL)::text
    FROM receipt_writeback w LEFT JOIN receipt_writeback_attempt a ON a.writeback_id=w.id WHERE w.id='${writebackId}'`)).trim();
  return row;
}

async function steps(writebackId: string) {
  const rows = (await sql(`SELECT step||':'||result||':'||reason FROM receipt_writeback_attempt_log
    WHERE writeback_id='${writebackId}' ORDER BY recorded_at,id`)).trim();
  return rows === '' ? [] : rows.split(/\r?\n/);
}

async function expireLease(writebackId: string) {
  await sql(`UPDATE receipt_writeback_attempt SET lease_expires_at=now()-interval '1 second'
    WHERE writeback_id='${writebackId}' AND lease_token IS NOT NULL`);
  assert.equal((await sql(`SELECT count(*) FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}' AND lease_expires_at<now()`)).trim(), '1',
    'the test must have expired a live lease');
}

const applyCalls = async (path: string) => (await new SyntheticStockSink(path, 'apply').ledger()).applyCalls;

function expectOutcome(outcome: WritebackOutcome | undefined, kind: WritebackOutcome['kind'], reason: string, message = '') {
  assert.ok(outcome, `expected a ${kind}/${reason} outcome ${message}`);
  assert.equal(outcome.kind, kind, `${message} ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, reason, `${message} ${JSON.stringify(outcome)}`);
  return outcome;
}

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  return { entered, proceed, enter: () => enter(), release: () => release() };
}

type LookupStep = 'answer' | 'fail' | 'hang' | 'pause_after';
type ApplyMode = 'delegate' | 'hang' | 'pause_before' | 'pause_after';

/** Wraps the independent synthetic sink so a test can hold a call at a chosen point, make a lookup fail or
 * hang, and count what the processor actually asked for. The ledger underneath stays the real evidence. */
class ScriptedSink implements StockReceiptSink {
  readonly inner: SyntheticStockSink;
  readonly guaranteesIdempotentApply: boolean;
  readonly lookupScript: readonly LookupStep[];
  readonly applyMode: ApplyMode;
  readonly applyGate = gate();
  readonly lookupGate = gate();
  lookups = 0;
  applies = 0;
  constructor(inner: SyntheticStockSink, script: { lookup?: readonly LookupStep[]; apply?: ApplyMode } = {}) {
    this.inner = inner;
    this.guaranteesIdempotentApply = inner.guaranteesIdempotentApply;
    this.lookupScript = script.lookup ?? ['answer'];
    this.applyMode = script.apply ?? 'delegate';
  }
  async lookup(sinkKey: string): Promise<StockReceiptEvidence | undefined> {
    const step = this.lookupScript[Math.min(this.lookups, this.lookupScript.length - 1)]!;
    this.lookups += 1;
    if (step === 'fail') throw Object.assign(new Error('Synthetic lookup unavailable'), { code: 'SINK_LOOKUP_UNAVAILABLE' });
    if (step === 'hang') return new Promise<never>(() => undefined);
    const found = await this.inner.lookup(sinkKey);
    if (step === 'pause_after') { this.lookupGate.enter(); await this.lookupGate.proceed; }
    return found;
  }
  async apply(payload: WritebackPayload): Promise<StockReceiptEvidence> {
    this.applies += 1;
    if (this.applyMode === 'hang') return new Promise<never>(() => undefined);
    if (this.applyMode === 'pause_before') { this.applyGate.enter(); await this.applyGate.proceed; }
    if (this.applyMode !== 'pause_after') return this.inner.apply(payload);
    try { return await this.inner.apply(payload); } finally { this.applyGate.enter(); await this.applyGate.proceed; }
  }
}

test('the queued/applied domain is not widened and attempt history is append-only for the runtime role', async (t) => {
  const { pool, directory, path } = await arrange(t);
  // 'queued' must keep meaning "not proven delivered". An in-flight value in this column would lose that.
  const definition = await sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='receipt_writeback'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%'`);
  assert.match(definition, /'queued'/);
  assert.match(definition, /'applied'/);
  for (const inFlight of ['checking', 'submitting', 'outcome_unknown', 'needs_reconciliation', 'unknown']) {
    assert.doesNotMatch(definition, new RegExp(`'${inFlight}'`), `receipt_writeback.status must not carry ${inFlight}`);
  }

  const { transaction, writebackId } = await seedReceipts(pool, directory);
  expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_after_apply');
  for (const statement of [
    `UPDATE receipt_writeback_attempt_log SET reason='rewritten' WHERE writeback_id='${writebackId}'`,
    `DELETE FROM receipt_writeback_attempt_log WHERE writeback_id='${writebackId}'`,
    `DELETE FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}'`,
  ]) {
    await assert.rejects(transaction((c) => c.query(statement)), /permission denied/, `the runtime role must not be able to run: ${statement}`);
  }
  assert.equal((await steps(writebackId)).length, 2);
});

test('the runtime role may update only the attempt columns the processor writes', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { transaction, writebackId } = await seedReceipts(pool, directory);
  expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_after_apply');
  const identity = async () => (await sql(`SELECT writeback_id||'|'||organisation_id||'|'||branch_id||'|'||sink_key||'|'||payload_hash||'|'||created_at
    FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}'`)).trim();
  const before = await identity();

  // Identity, tenant, stock receipt key, recorded payload and creation time are fixed once written. Each
  // statement runs in its own transaction so one refusal cannot mask the next. Every value written is a
  // valid one, so only a missing privilege can refuse it.
  for (const [column, value] of [
    ['writeback_id', `'${writebackId}'::uuid`],
    ['organisation_id', `'${ids.a}'::uuid`],
    ['branch_id', `'${ids.branchA}'::uuid`],
    ['sink_key', 'sink_key'],
    ['payload_hash', 'payload_hash'],
    ['created_at', 'created_at'],
  ] as const) {
    await assert.rejects(
      transaction((c) => c.query(`UPDATE receipt_writeback_attempt SET ${column}=${value} WHERE writeback_id=$1`, [writebackId])),
      /permission denied/,
      `the runtime role must not be able to update receipt_writeback_attempt.${column}`,
    );
  }

  // A column the processor writes on every settlement stays writable.
  const permitted = await transaction((c) => c.query(`UPDATE receipt_writeback_attempt SET last_detail='synthetic privilege probe',updated_at=now() WHERE writeback_id=$1`, [writebackId]));
  assert.equal(permitted.rowCount, 1, 'the runtime role must still be able to update a column the processor needs');
  assert.equal((await sql(`SELECT last_detail FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}'`)).trim(), 'synthetic privilege probe');
  assert.equal(await identity(), before, 'no protected column may have changed');
});

test('a confirmed receipt is delivered once, after a lookup, and inclusion stays unrecorded', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { transaction, intentId, lineId, writebackId, receiptId } = await seedReceipts(pool, directory);
  // A duplicated confirmation with the same stable reference is one receipt and one writeback.
  await transaction((c, x) => confirmReceipt(c, x, intentId, 'receipt-wb-1', [{ lineId, quantity: '1' }]));
  assert.equal((await sql('SELECT count(*) FROM receipt_writeback')).trim(), '1');

  const processor = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply'));
  const run = await processor.runOnce();
  assert.equal(run.kind, 'completed');
  assert.equal(run.outcomes.length, 1);
  const applied = expectOutcome(run.outcomes[0], 'applied', 'applied_after_apply');
  const key = syntheticSinkKey({ organisationId: ids.a, branchId: ids.branchA, receiptId });
  const ledger = await new SyntheticStockSink(path, 'apply').ledger();
  assert.equal(applied.kind === 'applied' && applied.sinkReceiptToken, syntheticStockReceiptToken(key, ledger.receipts[key]!.payloadHash));

  // Even a first send is preceded by a lookup, so a restored or replayed row can never send blindly.
  assert.deepEqual(await steps(writebackId), ['lookup:not_found:lookup_not_found_before_send', 'apply:acknowledged:applied_after_apply']);
  assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true', 'applied is delivery evidence; inclusion must stay NULL');

  assert.deepEqual((await processor.runOnce()).outcomes, [], 'an applied writeback must not be claimable again');
  expectOutcome(await processor.process(writebackId), 'applied', 'already_applied');
  assert.equal(ledger.applyCalls, 1);
  assert.equal(await applyCalls(path), 1, 'no second apply may be sent');
  assert.deepEqual(Object.keys((await new SyntheticStockSink(path, 'apply').ledger()).receipts), [key]);
});

test('competing workers and concurrent calls in one worker deliver a writeback exactly once', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const processors = Array.from({ length: 3 }, () => new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')));

  // Batch claims and addressed calls race on one row, across processors and within each one. Every call
  // must settle as a named outcome; a deadlock or lock error surfacing as a rejection is a failure.
  const settled = await Promise.allSettled(processors.flatMap((processor) => [
    processor.runOnce().then((run) => run.outcomes),
    processor.process(writebackId).then((outcome) => [outcome]),
    processor.process(writebackId).then((outcome) => [outcome]),
  ]));
  const rejected = settled.filter((result) => result.status === 'rejected');
  assert.deepEqual(rejected, [], 'no concurrent call may reject');
  const outcomes = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  assert.equal(outcomes.filter((outcome) => outcome.reason === 'applied_after_apply').length, 1, JSON.stringify(outcomes));
  assert.deepEqual(outcomes.filter((outcome) => outcome.kind === 'refused'), []);
  assert.equal(await applyCalls(path), 1, 'exactly one send');
  assert.equal((await steps(writebackId)).filter((step) => step.startsWith('apply:')).length, 1);
  assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
});

test('a second call in the same worker cannot take over a send that is still in flight', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const sink = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { apply: 'pause_before' });
  const processor = new WritebackProcessor(pool, scopeA, sink);

  const first = processor.process(writebackId);
  await sink.applyGate.entered;
  // The same worker instance asks again while its own send has not reached the sink. A lease that
  // identified the worker rather than the claim would let this call treat the live send as abandoned,
  // look up too early, find nothing and hold or resend.
  const second = await processor.process(writebackId);
  expectOutcome(second, 'queued', 'claimed_elsewhere');
  assert.equal(second.kind === 'queued' && second.phase, 'submitting');
  assert.equal(sink.lookups, 1, 'the second call must not look up a send that is still in flight');
  assert.equal(sink.applies, 1, 'the second call must not send');

  sink.applyGate.release();
  expectOutcome(await first, 'applied', 'applied_after_apply');
  assert.equal(await applyCalls(path), 1);
  assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
});

test('a worker that died after the sink recorded the receipt is recovered by lookup, never by a resend', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const dying = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { apply: 'pause_after' });
  const abandoned = new WritebackProcessor(pool, scopeA, dying).runOnce();
  await dying.applyGate.entered;
  // The sink holds the receipt; the worker that sent it never records the answer and its lease runs out.
  await expireLease(writebackId);

  const restarted = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply'));
  expectOutcome((await restarted.runOnce()).outcomes[0], 'applied', 'applied_found_by_lookup');
  assert.equal(await applyCalls(path), 1, 'recovery must not resend');
  assert.equal(await state(writebackId), 'applied|applied|2|-|-|token|true');

  // The original worker's answer finally arrives. It may observe the delivery; it may not change it.
  dying.applyGate.release();
  expectOutcome((await abandoned).outcomes[0], 'applied', 'already_applied');
  assert.equal(await applyCalls(path), 1);
  assert.deepEqual(await steps(writebackId), [
    'lookup:not_found:lookup_not_found_before_send',
    'lookup:found:applied_found_by_lookup',
    'apply:acknowledged:already_applied',
  ]);
});

test('a send that had not reached the sink when its lease expired is held, and its late evidence is still recorded', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const slow = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { apply: 'pause_before' });
  const stalled = new WritebackProcessor(pool, scopeA, slow).runOnce();
  await slow.applyGate.entered;
  await expireLease(writebackId);

  // Another worker finds a submitting attempt with an expired lease and nothing in the sink. The sink makes
  // no idempotency promise, so resending would risk a duplicate: it holds for an operator instead.
  const recovering = new ScriptedSink(new SyntheticStockSink(path, 'apply'));
  const held = (await new WritebackProcessor(pool, scopeA, recovering).runOnce()).outcomes[0];
  expectOutcome(held, 'queued', 'not_found_without_idempotency');
  assert.equal(recovering.applies, 0, 'a recovery must never send');
  assert.equal(await state(writebackId), 'queued|needs_reconciliation|2|-|not_found_without_idempotency|-|true');

  // The stalled send then lands. Its evidence is positive and matches the recorded payload, so it is
  // recorded rather than discarded because the claim that produced it was taken over.
  slow.applyGate.release();
  expectOutcome((await stalled).outcomes[0], 'applied', 'applied_after_apply');
  assert.equal(await applyCalls(path), 1);
  assert.equal(await state(writebackId), 'applied|applied|2|-|-|token|true');
});

test('a claim that lost its lease during the pre-send lookup never sends', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const slow = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { lookup: ['pause_after'] });
  const stalled = new WritebackProcessor(pool, scopeA, slow).runOnce();
  await slow.lookupGate.entered;
  await expireLease(writebackId);

  // A checking attempt provably sent nothing, so another worker may check again and send.
  expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_after_apply');

  // The stalled claim now holds a stale "not found". It must not act on it.
  slow.lookupGate.release();
  expectOutcome((await stalled).outcomes[0], 'applied', 'already_applied');
  assert.equal(slow.applies, 0, 'a claim that lost its lease must never send');
  assert.equal(await applyCalls(path), 1);
});

test('an unanswered apply is settled by lookup in the same run and never resent', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId, receiptId } = await seedReceipts(pool, directory);
  const outcome = expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'timeout_after_apply')).runOnce()).outcomes[0],
    'applied', 'applied_found_by_lookup');
  const key = syntheticSinkKey({ organisationId: ids.a, branchId: ids.branchA, receiptId });
  const ledger = await new SyntheticStockSink(path, 'apply').ledger();
  assert.equal(outcome.kind === 'applied' && outcome.sinkReceiptToken, syntheticStockReceiptToken(key, ledger.receipts[key]!.payloadHash));
  assert.equal(ledger.applyCalls, 1, 'no blind resend may follow an uncertain outcome');
  assert.deepEqual(await steps(writebackId), [
    'lookup:not_found:lookup_not_found_before_send',
    'apply:no_answer:sink_no_answer',
    'lookup:found:applied_found_by_lookup',
  ]);
  assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
});

test('a hung sink is abandoned at its deadline and the attempt is recorded as unknown', { timeout: 60_000 }, async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const hung = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { lookup: ['answer', 'hang'], apply: 'hang' });
  const processor = new WritebackProcessor(pool, scopeA, hung, { leaseMs: 1_000, sinkCallTimeoutMs: 100 });

  const started = process.hrtime.bigint();
  const outcome = (await processor.runOnce()).outcomes[0];
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsed < 15_000, `a hung sink must not hang the worker; waited ${elapsed}ms`);
  expectOutcome(outcome, 'queued', 'lookup_inconclusive');
  assert.equal(outcome!.kind === 'queued' && outcome!.phase, 'outcome_unknown');
  assert.deepEqual(await steps(writebackId), [
    'lookup:not_found:lookup_not_found_before_send',
    'apply:no_answer:sink_timeout',
    'lookup:inconclusive:lookup_timeout',
  ]);
  assert.equal(await state(writebackId), 'queued|outcome_unknown|1|-|-|-|true');
});

test('an unknown outcome no lookup can settle is never applied or resent, and escalates after bounded attempts', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  const sink = new ScriptedSink(new SyntheticStockSink(path, 'timeout_after_apply'), { lookup: ['answer', 'fail'] });
  const processor = new WritebackProcessor(pool, scopeA, sink, { maxAttempts: 2, retryDelayMs: 0 });

  expectOutcome((await processor.runOnce()).outcomes[0], 'queued', 'lookup_inconclusive');
  assert.equal(await state(writebackId), 'queued|outcome_unknown|1|-|-|-|true');
  expectOutcome((await processor.runOnce()).outcomes[0], 'queued', 'lookup_inconclusive');
  assert.equal(await state(writebackId), 'queued|outcome_unknown|2|-|-|-|true');
  expectOutcome((await processor.runOnce()).outcomes[0], 'queued', 'attempts_exhausted');
  assert.deepEqual((await processor.runOnce()).outcomes, [], 'a held writeback must never be claimed again');
  expectOutcome(await processor.process(writebackId), 'queued', 'held_for_operator');

  assert.equal(sink.applies, 1);
  assert.equal(await applyCalls(path), 1, 'refusing to prove delivery must not mean resending');
  assert.equal(await state(writebackId), 'queued|needs_reconciliation|2|-|attempts_exhausted|-|true');
  assert.deepEqual(await steps(writebackId), [
    'lookup:not_found:lookup_not_found_before_send',
    'apply:no_answer:sink_no_answer',
    'lookup:inconclusive:lookup_unavailable',
    'lookup:inconclusive:lookup_unavailable',
    'decision:held:attempts_exhausted',
  ]);
});

test('a transient refusal waits for its retry delay instead of exhausting every attempt in one run', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  // A marker left by another holder keeps the sink ledger locked; the sink refuses at once.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.lock`, JSON.stringify({ owner: 'synthetic-other-holder' }), { flag: 'wx' });
  const processor = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply', { lockWaitMs: 0 }), { maxAttempts: 2 });

  const first = await processor.runOnce();
  assert.equal(first.outcomes.length, 1, `one run must process a writeback at most once, got ${JSON.stringify(first)}`);
  expectOutcome(first.outcomes[0], 'queued', 'lookup_inconclusive');
  assert.equal(await state(writebackId), 'queued|pending|1|-|-|-|true');
  assert.deepEqual((await processor.runOnce()).outcomes, [], 'a released attempt is not due before its retry delay');
  expectOutcome(await processor.process(writebackId), 'queued', 'retry_not_due');

  await sql(`UPDATE receipt_writeback_attempt SET not_before=now()-interval '1 second' WHERE writeback_id='${writebackId}'`);
  await rm(`${path}.lock`);
  expectOutcome((await processor.runOnce()).outcomes[0], 'applied', 'applied_after_apply');
  assert.equal(await state(writebackId), 'applied|applied|2|-|-|token|true');
  assert.deepEqual(await steps(writebackId), [
    'lookup:inconclusive:lookup_unavailable',
    'lookup:not_found:lookup_not_found_before_send',
    'apply:acknowledged:applied_after_apply',
  ]);
});

test('a receipt whose payload cannot be built is held without blocking the rest of the queue', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { receipts, lineId } = await seedReceipts(pool, directory, ['receipt-wb-1', 'receipt-wb-2']);
  const [good, poison] = receipts as [typeof receipts[0], typeof receipts[0]];
  // '1.0' is the same number but not a canonical recorded quantity; the payload refuses rather than rewrites
  // it. The edit stands in for any receipt row the payload builder cannot describe exactly.
  await sql(`UPDATE receipt SET lines='[{"lineId":"${lineId}","quantity":"1.0"}]'::jsonb WHERE id='${poison.receiptId}'`);

  const run = await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce();
  assert.equal(run.kind, 'completed', JSON.stringify(run));
  const byId = new Map(run.outcomes.map((outcome) => [outcome.writebackId, outcome]));
  expectOutcome(byId.get(good.writebackId), 'applied', 'applied_after_apply', 'the healthy writeback must still be delivered');
  expectOutcome(byId.get(poison.writebackId), 'queued', 'payload_unbuildable', 'the poison row must be held with a named reason');
  assert.equal(await state(poison.writebackId), 'queued|needs_reconciliation|0|-|payload_unbuildable|-|true');
  assert.deepEqual(await steps(poison.writebackId), ['decision:held:payload_unbuildable']);
  assert.deepEqual((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes, []);
  assert.equal(await applyCalls(path), 1);
});

test('a receipt that changed under a recorded attempt is held, not resent', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId, lineId, receiptId } = await seedReceipts(pool, directory);
  const sink = new ScriptedSink(new SyntheticStockSink(path, 'timeout_after_apply'), { lookup: ['answer', 'fail'] });
  const processor = new WritebackProcessor(pool, scopeA, sink, { retryDelayMs: 0 });
  expectOutcome((await processor.runOnce()).outcomes[0], 'queued', 'lookup_inconclusive');
  const recorded = (await sql(`SELECT payload_hash FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}'`)).trim();

  // Diverge the durable receipt from what the attempt vouched for. The application never does this; it
  // stands in for any out-of-band edit that makes the recorded attempt describe a different receipt.
  await sql(`UPDATE receipt SET lines='[{"lineId":"${lineId}","quantity":"2"}]'::jsonb WHERE id='${receiptId}'`);

  const outcome = expectOutcome((await processor.runOnce()).outcomes[0], 'queued', 'payload_changed');
  assert.ok(outcome.detail.includes(recorded), 'the refusal must name the hash the attempt was recorded against');
  assert.equal((await sql(`SELECT payload_hash FROM receipt_writeback_attempt WHERE writeback_id='${writebackId}'`)).trim(), recorded,
    'holding must not rewrite the recorded evidence');
  assert.equal(await state(writebackId), 'queued|needs_reconciliation|1|-|payload_changed|-|true');
  assert.equal(sink.applies, 1);
  assert.equal(await applyCalls(path), 1);
});

test('a receipt that changes during a live send is judged by that send, not held out from under it', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId, lineId, receiptId } = await seedReceipts(pool, directory);
  const sink = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { apply: 'pause_before' });
  const sending = new WritebackProcessor(pool, scopeA, sink).process(writebackId);
  await sink.applyGate.entered;
  await sql(`UPDATE receipt SET lines='[{"lineId":"${lineId}","quantity":"2"}]'::jsonb WHERE id='${receiptId}'`);

  // A competing worker sees a changed payload, but the attempt belongs to a live claim. Holding it here
  // would clear that claim's lease while its send is still in flight.
  expectOutcome(await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).process(writebackId), 'queued', 'claimed_elsewhere');
  assert.equal(await state(writebackId), 'queued|submitting|1|leased|-|-|true');

  // The send lands with evidence for the old payload. Re-derived under lock, the receipt no longer matches,
  // so the owning claim holds it rather than recording evidence for a receipt that is not there.
  sink.applyGate.release();
  expectOutcome(await sending, 'queued', 'receipt_changed_during_call');
  assert.equal(await state(writebackId), 'queued|needs_reconciliation|1|-|receipt_changed_during_call|-|true');
  assert.equal(await applyCalls(path), 1);
});

test('without an idempotency guarantee "not found" after an unanswered send holds; with one a checked resend is permitted', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId } = await seedReceipts(pool, directory);
  // The sink is never reached, so nothing is recorded and every lookup finds nothing. That is still not
  // proof no send is in flight, and this sink promises nothing about repeated applies.
  const held = (await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'unavailable')).runOnce()).outcomes[0];
  expectOutcome(held, 'queued', 'not_found_without_idempotency');
  assert.deepEqual(await steps(writebackId), [
    'lookup:not_found:lookup_not_found_before_send',
    'apply:no_answer:sink_no_answer',
    'lookup:not_found:not_found_without_idempotency',
  ]);

  // The same unsettled attempt against a sink that explicitly guarantees idempotent apply is released for
  // a further attempt, and that attempt still looks up before it sends.
  await sql(`UPDATE receipt_writeback_attempt SET phase='outcome_unknown',hold_reason=NULL WHERE writeback_id='${writebackId}'`);
  const guaranteed = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'unavailable', { idempotentApply: true }), { retryDelayMs: 0 });
  expectOutcome((await guaranteed.runOnce()).outcomes[0], 'queued', 'not_found_retry_permitted');
  assert.equal(await state(writebackId), 'queued|pending|2|-|-|-|true');
  const delivering = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply', { idempotentApply: true }));
  expectOutcome((await delivering.runOnce()).outcomes[0], 'applied', 'applied_after_apply');
  assert.deepEqual((await steps(writebackId)).slice(-2), ['lookup:not_found:lookup_not_found_before_send', 'apply:acknowledged:applied_after_apply']);
  assert.equal(await applyCalls(path), 1);
});

test('a settlement that cannot take its lock leaves no half-applied state and is recovered by lookup', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { transaction, writebackId } = await seedReceipts(pool, directory);
  const sink = new ScriptedSink(new SyntheticStockSink(path, 'apply'), { apply: 'pause_before' });
  const running = new WritebackProcessor(pool, scopeA, sink, { lockTimeoutMs: 200 }).runOnce();
  await sink.applyGate.entered;

  // While the send is in flight, another transaction holds the writeback row, so the transaction that
  // would record the sink's positive evidence cannot take its lock inside the bound.
  const holding = gate();
  const holder = transaction(async (c) => {
    await c.query('SELECT id FROM receipt_writeback WHERE id=$1 FOR UPDATE', [writebackId]);
    holding.enter();
    await holding.proceed;
  });
  await holding.entered;
  sink.applyGate.release();
  const run = await running;
  holding.release();
  await holder;

  assert.equal(run.kind, 'completed', 'a lock timeout while settling must be reported, not thrown');
  expectOutcome(run.outcomes[0], 'refused', 'database_lock_timeout');
  assert.equal(await applyCalls(path), 1, 'the sink did record the receipt');
  // Nothing partial: not applied, no token, no acknowledgement recorded, and the attempt still says a send
  // may have happened, which forces a lookup.
  assert.equal(await state(writebackId), 'queued|submitting|1|leased|-|-|true');
  assert.deepEqual(await steps(writebackId), ['lookup:not_found:lookup_not_found_before_send']);

  await expireLease(writebackId);
  expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_found_by_lookup');
  assert.equal(await applyCalls(path), 1, 'recovery must not resend');
  assert.equal(await state(writebackId), 'applied|applied|2|-|-|token|true');
});

test('row security holds for every writeback read and write', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { writebackId, receiptId } = await seedReceipts(pool, directory);
  await sql(`INSERT INTO membership(id,organisation_id,user_subject,role,status) VALUES ('${ownerC.id}','${ids.b}','${ownerC.subject}','pharmacy_owner','active');
    INSERT INTO membership_branch VALUES ('${ids.b}','${ownerC.id}','${ids.branchB}');`);
  const scopeC = { subject: ownerC.subject, organisationId: ids.b, branchId: ids.branchB };
  const asC = <T>(callback: Parameters<typeof withTransaction<T>>[4]) => withTransaction(pool, scopeC.subject, scopeC.organisationId, scopeC.branchId, callback);

  // Before tenant A has any attempt state, a runtime session in tenant B tries to attach some to A's
  // writeback by naming its id under B's own tenant columns. Its own policy accepts those columns, and a
  // reference by id alone is checked with row security bypassed, so only binding the child rows to the
  // writeback's tenant refuses it. Done first so a primary key collision cannot mask the result.
  const key = syntheticSinkKey({ organisationId: ids.b, branchId: ids.branchB, receiptId });
  await assert.rejects(asC((c) => c.query(`INSERT INTO receipt_writeback_attempt(writeback_id,organisation_id,branch_id,sink_key,phase,hold_reason,last_reason)
    VALUES($1,$2,$3,$4,'needs_reconciliation','squatting','squatting')`, [writebackId, ids.b, ids.branchB, key])), /foreign key/);
  await assert.rejects(asC((c) => c.query(`INSERT INTO receipt_writeback_attempt_log(organisation_id,branch_id,writeback_id,attempt,step,result,reason)
    VALUES($1,$2,$3,0,'decision','held','squatting')`, [ids.b, ids.branchB, writebackId])), /foreign key/);
  // Nor can it write rows carrying tenant A's columns.
  await assert.rejects(asC((c) => c.query(`INSERT INTO receipt_writeback_attempt_log(organisation_id,branch_id,writeback_id,attempt,step,result,reason)
    VALUES($1,$2,$3,0,'decision','held','squatting')`, [ids.a, ids.branchA, writebackId])), /row-level security/);
  assert.equal((await sql('SELECT count(*) FROM receipt_writeback_attempt')).trim(), '0');

  expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_after_apply',
    'tenant A must still deliver its own writeback');

  // memberB is a purchaser: not a writeback role, refused before any row is read.
  const purchaser = new WritebackProcessor(pool, scopeB, new SyntheticStockSink(path, 'apply'));
  const refusedRun = await purchaser.runOnce();
  assert.equal(refusedRun.kind, 'stopped');
  assert.equal(refusedRun.kind === 'stopped' && refusedRun.reason, 'forbidden');
  expectOutcome(await purchaser.process(writebackId), 'refused', 'forbidden');

  // A pharmacy owner in another organisation is privileged but tenant-scoped.
  const foreign = new WritebackProcessor(pool, scopeC, new SyntheticStockSink(path, 'apply'));
  assert.deepEqual(await foreign.runOnce(), { kind: 'completed', outcomes: [] });
  expectOutcome(await foreign.process(writebackId), 'refused', 'not_found');
  const count = async (table: string) => String((await asC((c) => c.query(`SELECT count(*)::text AS value FROM ${table}`))).rows[0].value);
  assert.equal(await count('receipt_writeback_attempt'), '0');
  assert.equal(await count('receipt_writeback_attempt_log'), '0');
  assert.equal((await asC((c) => c.query(`UPDATE receipt_writeback_attempt SET last_reason='tampered' WHERE writeback_id=$1`, [writebackId]))).rowCount, 0);

  assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
  assert.equal((await sql('SELECT count(*) FROM receipt_writeback_attempt')).trim(), '1');
  assert.equal((await sql(`SELECT count(*) FROM receipt_writeback_attempt_log WHERE reason='squatting'`)).trim(), '0');
});

test('lost attempt state is resolved by lookup for every queued writeback, however large the queue', async (t) => {
  const { pool, directory, path } = await arrange(t);
  const { receipts } = await seedReceipts(pool, directory, ['receipt-wb-1', 'receipt-wb-2']);
  const first = await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce();
  assert.equal(first.outcomes.filter((outcome) => outcome.kind === 'applied').length, 2);
  assert.equal(await applyCalls(path), 2);

  // Stand-in for a restore to before delivery: the database forgets every attempt while the independent
  // sink ledger keeps both stock receipts. The queue is larger than one batch.
  await sql(`DELETE FROM receipt_writeback_attempt_log; DELETE FROM receipt_writeback_attempt; UPDATE receipt_writeback SET status='queued';`);
  const restored = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply'), { batch: 1 });
  for (let run = 0; run < 2; run += 1) {
    const outcomes = (await restored.runOnce()).outcomes;
    assert.equal(outcomes.length, 1);
    expectOutcome(outcomes[0], 'applied', 'applied_found_by_lookup', `run ${run + 1} must settle from the retained ledger`);
  }
  assert.deepEqual((await restored.runOnce()).outcomes, []);
  assert.equal(await applyCalls(path), 2, 'no writeback beyond the first batch may be resent');
  for (const { writebackId } of receipts) {
    assert.deepEqual(await steps(writebackId), ['lookup:found:applied_found_by_lookup']);
    assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
  }
});

test('AC-014 shape: an actual database restore reuses the retained stock receipt instead of sending again', async (t) => {
  let pool = await resetDatabase();
  const directory = await mkdtemp(join(process.cwd(), 'tmp-writeback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A restore can exceed 30 seconds on Windows after the full serial database gate has loaded Docker.
  // Keep it finite while allowing Docker Desktop enough time to flush and rebuild the database.
  const docker = (args: string[]) => execFileSync('docker', ['compose', '-p', 'pharmacart', '-f', 'infra/compose.yaml', 'exec', '-T', 'postgres', ...args], { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
  try {
    await preconditions();
    const path = join(directory, 'stock', 'sink.json');
    const { writebackId, receiptId } = await seedReceipts(pool, directory);
    // The backup is taken while the writeback is still queued and no attempt row exists.
    docker(['pg_dump', '-U', 'pharmacart_bootstrap', '-d', 'pharmacart_test', '-Fc', '-f', '/tmp/pharmacart-writeback.dump']);

    expectOutcome((await new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply')).runOnce()).outcomes[0], 'applied', 'applied_after_apply');
    const delivered = await new SyntheticStockSink(path, 'apply').ledger();
    assert.equal(delivered.applyCalls, 1);

    await pool.end();
    docker(['pg_restore', '-U', 'pharmacart_bootstrap', '-d', 'pharmacart_test', '--clean', '--if-exists', '--exit-on-error', '/tmp/pharmacart-writeback.dump']);
    pool = await createRuntimePool(await configureRuntimeLogin());
    assert.equal(await state(writebackId), 'queued|-|-|-|-|-|true', 'the restore must put the writeback back in the queue with no attempt');

    // No startup pass is required: the claim itself looks up before it may send.
    const restored = new WritebackProcessor(pool, scopeA, new SyntheticStockSink(path, 'apply'));
    expectOutcome((await restored.runOnce()).outcomes[0], 'applied', 'applied_found_by_lookup');
    const after = await new SyntheticStockSink(path, 'apply').ledger();
    assert.equal(after.applyCalls, 1, 'a restore must not cause a second delivery');
    assert.deepEqual(Object.keys(after.receipts), Object.keys(delivered.receipts));
    assert.ok(after.receipts[syntheticSinkKey({ organisationId: ids.a, branchId: ids.branchA, receiptId })]);
    assert.equal(await state(writebackId), 'applied|applied|1|-|-|token|true');
    assert.deepEqual((await restored.runOnce()).outcomes, []);
  } finally {
    if (!pool.ending) await pool.end();
  }
});
