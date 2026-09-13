import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeSupplier, type Acknowledgement, type SupplierLine } from '../../supplier/src/fake.ts';
import { IntentWorker, confirmReceipt } from '../src/orders.ts';
import { ids, sql, resetDatabase } from './support.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { createQuote, approveQuote } from '../src/procurement.ts';
import { withTransaction } from '../src/runtime.ts';

// Competing workers, stale reconciliation lookups and repeated receipts all reach the same synthetic
// order. These tests drive real concurrency against PostgreSQL: the supplier is delayed at chosen
// points so one worker observes the order while another is still mid-attempt. They assert the durable
// record and the synthetic ledger, never the internal steps that produce them.

const secondNeed = '40000000-0000-4000-8000-000000000009';
const secondMap = '70000000-0000-4000-8000-000000000009';
const secondOffer = '90000000-0000-4000-8000-000000000009';
const boxes = (needId: string, quantity: string) => ({ needId, needVersion: 1, quantity, unit: 'box' });

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => settle() };
}

/** Holds a submission at a chosen point so a competing worker can act while the attempt is unfinished.
 * `before_ledger` models a send that has not yet reached the supplier; `after_ledger` models a send the
 * supplier has already recorded but whose caller never learns the outcome. */
class PausingSupplier extends FakeSupplier {
  readonly entered = deferred();
  readonly proceed = deferred();
  readonly pauseAt: 'before_ledger' | 'after_ledger';
  constructor(path: string, mode: 'accepted' | 'partial' | 'timeout_after_accept', pauseAt: 'before_ledger' | 'after_ledger') {
    super(path, mode);
    this.pauseAt = pauseAt;
  }
  async submit(reference: string, lines: SupplierLine[]): Promise<Acknowledgement> {
    if (this.pauseAt === 'before_ledger') {
      this.entered.resolve();
      await this.proceed.promise;
      return super.submit(reference, lines);
    }
    try { return await super.submit(reference, lines); }
    finally { this.entered.resolve(); await this.proceed.promise; }
  }
}

/** A transport that never reaches the supplier: the attempt settles as genuinely unknown with no
 * external record to find. */
class LostSupplier extends FakeSupplier {
  async submit(): Promise<Acknowledgement> { throw new Error('Synthetic transport failure before send'); }
}

async function arrange(t: TestContext, lines: { needId: string; needVersion: number; quantity: string; unit: string }[]) {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedProcurement();
  // A second verified pack for the same supplier gives the order two lines, so a receipt can fail on the
  // later line after the earlier one has already been updated.
  await sql(`INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES
    ('${secondMap}','${ids.a}','${ids.branchA}','60000000-0000-4000-8000-000000000002','verified',1);
    INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity,source_map_id) VALUES
    ('${secondNeed}','${ids.a}','${ids.branchA}','SYN-A-SECOND',3,'${secondMap}');
    INSERT INTO account_offer(id,organisation_id,branch_id,relationship_id,product_id,unit,unit_price,currency,version,terms_version,expires_at) VALUES
    ('${secondOffer}','${ids.a}','${ids.branchA}','80000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','box',5.00,'EGP',1,1,now()+interval '1 hour');`);

  const scope = { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA };
  const transaction = <T>(callback: Parameters<typeof withTransaction<T>>[4]) =>
    withTransaction(pool, scope.subject, scope.organisationId, scope.branchId, callback);
  const quote = await transaction((c, x) => createQuote(c, x, { branchId: ids.branchA, lines, constraints: { supplierIds: [], paymentTerm: 'cash' } }));
  const approval = await transaction((c, x) => approveQuote(c, x, quote.id, 1, 'recovery-concurrency'));
  const intentId = approval.body.orderIntentIds[0]!;

  const rows = async (text: string, values: unknown[] = []) => (await transaction((c) => c.query(text, values))).rows;
  const one = async (text: string) => String((await rows(text))[0]!.value);
  return {
    pool, scope, transaction, intentId, rows, one, total: quote.total,
    ledgerPath: join(directory, 'ledger', 'ledger.json'),
    worker: (supplier: FakeSupplier) => new IntentWorker(pool, scope, supplier),
    state: () => one('SELECT state AS value FROM order_intent'),
    version: async () => Number((await rows('SELECT version AS value FROM order_intent'))[0]!.value),
    reservation: () => one('SELECT status AS value FROM budget_reservation'),
    // Rounding fixes the numeric scale so the comparison is about value, not PostgreSQL text formatting.
    budget: () => one("SELECT round(reserved_amount,2)::text||'/'||round(spent_amount,2)::text AS value FROM budget"),
    events: (type: string) => one(`SELECT count(*) AS value FROM procurement_outbox WHERE event_type='${type}'`),
    // Line identifiers are derived hashes, so need order is the only stable ordering for assertions.
    orderLines: () => rows('SELECT id,ordered::text,accepted::text,rejected::text,shipped::text,received::text FROM order_line ORDER BY need_id'),
    reference: () => one('SELECT external_client_ref AS value FROM order_intent'),
  };
}

test('a stale not-found lookup cannot demote a submission that is still in flight', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2')]);
  const supplier = new PausingSupplier(ground.ledgerPath, 'accepted', 'before_ledger');
  const dispatcher = ground.worker(supplier);
  const reconciler = ground.worker(supplier);
  await dispatcher.enableSyntheticDispatch();
  await reconciler.enableSyntheticDispatch();

  const attempt = dispatcher.run(ground.intentId);
  await supplier.entered.promise;
  assert.equal(await ground.state(), 'submitting');
  const claimed = await ground.version();

  // The supplier has no record yet, so this reconciliation sees a not-found answer for a live send.
  assert.equal((await reconciler.reconcile(ground.intentId)).state, 'submitting',
    'a not-found lookup must not settle an attempt that may still be in flight');
  assert.equal(await ground.state(), 'submitting', 'the live submission must keep its state');
  assert.equal(await ground.version(), claimed, 'a refused transition must not bump the aggregate version');
  assert.equal(await ground.reservation(), 'reserved', 'an unfinished outcome keeps its budget reservation');

  supplier.proceed.resolve();
  assert.equal((await attempt).state, 'acknowledged', 'the in-flight acknowledgement must not be lost');
  assert.equal(await ground.state(), 'acknowledged');
  assert.equal((await supplier.ledger()).submitCalls, 1, 'the stale lookup must not trigger a second submission');
  assert.equal(await ground.events('OrderOutcomeUnknown'), '0');
});

test('a worker overtaken during an uncertain send reports the durable outcome', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2')]);
  // The supplier records the order and then loses the connection, so this worker can never see its result.
  const supplier = new PausingSupplier(ground.ledgerPath, 'timeout_after_accept', 'after_ledger');
  const dispatcher = ground.worker(supplier);
  const reconciler = ground.worker(supplier);
  await dispatcher.enableSyntheticDispatch();
  await reconciler.enableSyntheticDispatch();

  const attempt = dispatcher.run(ground.intentId);
  await supplier.entered.promise;
  assert.equal((await reconciler.reconcile(ground.intentId)).state, 'acknowledged',
    'a lookup that finds the order settles it from adapter evidence');

  supplier.proceed.resolve();
  assert.equal((await attempt).state, 'acknowledged',
    'the overtaken worker must report the settled outcome, not its own lost connection');
  assert.equal(await ground.state(), 'acknowledged');
  assert.equal(await ground.events('OrderOutcomeUnknown'), '0',
    'no unknown-outcome fact may be published for an order that is acknowledged');
  assert.equal(await ground.events('OrderAcknowledged'), '1');
  assert.equal(await ground.one('SELECT outcome AS value FROM submission_attempt'), 'acknowledged');
  assert.equal((await supplier.ledger()).submitCalls, 1);
});

test('competing workers claim and submit a queued intent exactly once', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2')]);
  const supplier = new FakeSupplier(ground.ledgerPath, 'accepted');
  const first = ground.worker(supplier);
  const second = ground.worker(supplier);
  await first.enableSyntheticDispatch();
  await second.enableSyntheticDispatch();

  await Promise.all([first.run(ground.intentId), second.run(ground.intentId)]);

  const ledger = await supplier.ledger();
  assert.equal(ledger.submitCalls, 1, 'only one worker may claim a queued intent');
  assert.equal(Object.keys(ledger.orders).length, 1);
  assert.equal(await ground.one('SELECT count(*) AS value FROM submission_attempt'), '1');
  assert.equal(await ground.state(), 'acknowledged');
  assert.equal(await ground.one('SELECT external_order_id AS value FROM order_intent'),
    ledger.orders[await ground.reference()]!.externalOrderId, 'the durable record must name the one external order');
  assert.equal((await second.run(ground.intentId)).state, 'acknowledged', 'a later run must not resubmit a settled intent');
  assert.equal((await supplier.ledger()).submitCalls, 1);
});

test('a refused supplier ledger keeps the intent queued, reserved and unsubmitted', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2')]);
  await mkdir(dirname(ground.ledgerPath), { recursive: true });
  // Another holder owns the ledger. Its age must never authorise a takeover, so every access is refused.
  await writeFile(`${ground.ledgerPath}.lock`, JSON.stringify({ owner: 'synthetic-other-process' }), { flag: 'wx' });
  const supplier = new FakeSupplier(ground.ledgerPath, 'accepted', { lockWaitMs: 100, lockPollMs: 10 });
  const worker = ground.worker(supplier);

  assert.equal((await worker.run(ground.intentId)).state, 'paused', 'dispatch stays paused until recovery has run');
  await worker.enableSyntheticDispatch();
  assert.equal(await ground.state(), 'queued', 'a refused lookup must not change the durable state');
  assert.equal((await worker.run(ground.intentId)).state, 'outcome_unknown',
    'a ledger that cannot be read must never be treated as proof that nothing was submitted');
  assert.equal(await ground.state(), 'queued');
  assert.equal(await ground.one('SELECT count(*) AS value FROM submission_attempt'), '0', 'no send may be attempted');
  assert.equal(await ground.reservation(), 'reserved');
  assert.equal(await ground.one("SELECT count(*) AS value FROM order_intent WHERE state='human_review'"), '0');

  await rm(`${ground.ledgerPath}.lock`);
  assert.equal((await worker.run(ground.intentId)).state, 'acknowledged', 'normal dispatch resumes once access is available');
  assert.equal((await supplier.ledger()).submitCalls, 1);
});

test('a settled unknown outcome with no supplier record escalates to human review exactly once', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2')]);
  const supplier = new LostSupplier(ground.ledgerPath, 'accepted');
  const worker = ground.worker(supplier);
  await worker.enableSyntheticDispatch();

  assert.equal((await worker.run(ground.intentId)).state, 'outcome_unknown');
  assert.equal(await ground.one('SELECT outcome AS value FROM submission_attempt'), 'unknown');
  assert.equal(await ground.events('OrderOutcomeUnknown'), '1');
  assert.equal(await ground.reservation(), 'reserved', 'an unknown outcome keeps its reservation');

  assert.equal((await worker.reconcile(ground.intentId)).state, 'human_review');
  const escalated = await ground.version();
  assert.equal((await worker.reconcile(ground.intentId)).state, 'human_review');
  assert.equal(await ground.version(), escalated, 'a settled escalation must not be rewritten on every pass');
  assert.equal((await worker.run(ground.intentId)).state, 'human_review', 'human review must not be dispatched automatically');
  assert.equal(await ground.reservation(), 'reserved');
  assert.equal((await supplier.ledger()).submitCalls, 0, 'an escalated intent must never be blindly resubmitted');
});

test('a receipt failing on a later line leaves no partial stock, receipt, writeback or spend', async (t) => {
  const ground = await arrange(t, [boxes(ids.needA, '2'), boxes(secondNeed, '3')]);
  const supplier = new FakeSupplier(ground.ledgerPath, 'partial');
  const worker = ground.worker(supplier);
  await worker.enableSyntheticDispatch();
  assert.equal((await worker.run(ground.intentId)).state, 'acknowledged');

  const [first, second] = await ground.orderLines();
  assert.deepEqual([first!.accepted, second!.accepted], ['1', '2'], 'the synthetic supplier accepts one unit less per line');
  assert.deepEqual([first!.shipped, second!.shipped], ['1', '2']);
  assert.equal(ground.total, '39.7');
  assert.equal(await ground.budget(), '39.70/0.00');

  const lines = [{ lineId: String(first!.id), quantity: '1' }, { lineId: String(second!.id), quantity: '9' }];
  await assert.rejects(ground.transaction((c, x) => confirmReceipt(c, x, ground.intentId, 'receipt-rollback', lines)),
    /RECEIPT_EXCEEDS_SHIPPED/);
  assert.deepEqual((await ground.orderLines()).map((line) => line.received), ['0', '0'],
    'the earlier line update must roll back with the failed receipt');
  assert.equal(await ground.one('SELECT count(*) AS value FROM receipt'), '0');
  assert.equal(await ground.one('SELECT count(*) AS value FROM receipt_writeback'), '0');
  assert.equal(await ground.budget(), '39.70/0.00', 'a failed receipt must not settle any budget');
  assert.equal(await ground.reservation(), 'reserved');

  // The corrected receipt is then confirmed concurrently; the order completes once.
  const corrected = [{ lineId: String(first!.id), quantity: '1' }, { lineId: String(second!.id), quantity: '2' }];
  const confirmed = await Promise.all(Array.from({ length: 3 }, () =>
    ground.transaction((c, x) => confirmReceipt(c, x, ground.intentId, 'receipt-rollback', corrected))));
  assert.equal(new Set(confirmed.map((receipt) => receipt.id)).size, 1, 'a replayed receipt keeps one identity');
  assert.equal(await ground.one('SELECT count(*) AS value FROM receipt'), '1');
  assert.equal(await ground.one('SELECT count(*) AS value FROM receipt_writeback'), '1', 'one receipt permits one writeback');
  assert.deepEqual((await ground.orderLines()).map((line) => line.received), ['1', '2']);
  assert.equal(await ground.budget(), '0.00/22.35', 'the reservation is released and the accepted value spent exactly once');
  assert.equal(await ground.reservation(), 'released');
});
