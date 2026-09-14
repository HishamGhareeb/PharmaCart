import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

import {
  acceptAlertSignal, NotificationDispatcher, NotificationError, resolveAlertEpisode,
  type Clock, type IncomingAlertSignal,
} from '../src/notifications.ts';
import { SyntheticFileDeliverySink, type DeliveryReceipt, type DeliverySink } from '../../notifications/src/sink.ts';
import { sealDeliveryPayload, type SafeDeliveryPayload } from '../../notifications/src/payload.ts';
import { MAX_LOOKUP_FAILURES } from '../../notifications/src/dispatch.ts';
import type { DispatcherOptions } from '../../notifications/src/dispatch.ts';
import { ids, sql, resetDatabase } from './support.ts';

/**
 * AWAITING COORDINATOR EXECUTION. These tests need the shared pharmacart_test database with migration
 * 0019 applied, which the builder of this slice may not touch. They have never been run; no assertion
 * below is evidence until the coordinator has executed them and recorded the output. AC-017 stays
 * NOT RUN until then.
 *
 * Run alone with:
 *   node --experimental-strip-types --test --test-concurrency=1 packages/db/test/notifications.test.ts
 *
 * Tests marked "Regression, finding X" reproduce a defect in the integrated lane and are expected to
 * fail against its code. The finding letters match docs/testing/synthetic-alert-delivery.md.
 * Branch fixtures use Asia/Bahrain, which is UTC+3 all year, so a 22:00-07:00 window is 19:00Z-04:00Z.
 */

const connector = 'synthetic:connector:a';
const otherConnector = 'synthetic:connector:b';
const installationB = '50000000-0000-4000-8000-000000000002';

const signal: IncomingAlertSignal = {
  signalId: 'sig-0001',
  conditionKey: `${ids.installation}:00017`,
  severity: 'actionable',
  observedAt: '2026-09-12T11:59:00.000Z',
  subject: 'SYN-INVENTORY-PACK',
  detail: 'On hand 2 of target 10',
};

const at = (instant: string): Clock => () => instant;
const noon = at('2026-09-12T12:00:00.000Z');
/** 23:30 local in Asia/Bahrain, inside a 22:00-07:00 window. */
const night = at('2026-09-12T20:30:00.000Z');

async function workspace(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-notify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'sink.json');
}

function sink(path: string, mode: 'delivered' | 'timeout_after_accept' | 'unavailable' = 'delivered') {
  return new SyntheticFileDeliverySink({ path, mode, clock: noon, lockWaitMs: 2_000, lockPollMs: 5 });
}

function dispatcher(pool: Pool, adapter: DeliverySink, clock: Clock = noon, options: DispatcherOptions = {}) {
  return new NotificationDispatcher(
    pool, { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA },
    adapter, clock, { allowSyntheticSink: true, leaseMs: 60_000, batchSize: 10, sinkTimeoutMs: 5_000, ...options },
  );
}

/** A sink that holds every send at a barrier until released, so a competing worker acts mid-send. */
class PausingSink implements DeliverySink {
  readonly kind = 'synthetic' as const;
  readonly reached: Promise<void>;
  private readonly inner: SyntheticFileDeliverySink;
  private readonly gate: Promise<void>;
  private markReached: () => void = () => undefined;
  private openGate: () => void = () => undefined;

  constructor(inner: SyntheticFileDeliverySink) {
    this.inner = inner;
    this.reached = new Promise((resolve) => { this.markReached = resolve; });
    this.gate = new Promise((resolve) => { this.openGate = resolve; });
  }

  lookup(deliveryId: string): Promise<DeliveryReceipt | undefined> { return this.inner.lookup(deliveryId); }

  async deliver(deliveryId: string, payload: SafeDeliveryPayload): Promise<DeliveryReceipt> {
    this.markReached();
    await this.gate;
    return this.inner.deliver(deliveryId, payload);
  }

  release(): void { this.openGate(); }
}

/** A provider that accepts the connection and never answers. */
class HangingSink implements DeliverySink {
  readonly kind = 'synthetic' as const;
  deliverCalls = 0;
  private readonly inner: SyntheticFileDeliverySink;
  constructor(inner: SyntheticFileDeliverySink) { this.inner = inner; }
  lookup(deliveryId: string): Promise<DeliveryReceipt | undefined> { return this.inner.lookup(deliveryId); }
  deliver(): Promise<DeliveryReceipt> { this.deliverCalls += 1; return new Promise(() => undefined); }
}

async function seed(activePolicy = true) {
  const pool = await resetDatabase();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status,paired_at)
    VALUES ('${ids.installation}','${ids.a}','${ids.branchA}','${connector}','active',now()),
           ('${installationB}','${ids.b}','${ids.branchB}','${otherConnector}','active',now())`);
  if (activePolicy) {
    await sql(`INSERT INTO notification_policy(organisation_id,branch_id,status,quiet_hours_enabled,
      quiet_start_minute,quiet_end_minute,bypass_severities) VALUES
      ('${ids.a}','${ids.branchA}','active',true,1320,420,ARRAY['critical']),
      ('${ids.b}','${ids.branchB}','active',true,1320,420,ARRAY['critical'])`);
  }
  return pool;
}

const count = async (table: string) => (await sql(`SELECT count(*) FROM ${table}`)).trim();
const scalar = async (query: string) => (await sql(query)).trim();

/** Runs statements as pharmacart_runtime inside one tenant's scope, then rolls back. */
async function asRuntime<T>(pool: Pool, organisationId: string, branchId: string, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE pharmacart_runtime');
    await client.query("SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)",
      [organisationId, branchId]);
    return await action(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function rejectsWith(code: string, reason?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof NotificationError, `expected NotificationError, received ${String(error)}`);
    assert.equal(error.code, code);
    if (reason !== undefined) assert.equal(error.reason, reason);
    return true;
  };
}

async function attempts() {
  return (await sql(`SELECT kind || ':' || coalesce(outcome,'none') FROM notification_delivery_attempt
    ORDER BY recorded_at, id`)).trim().split('\n').filter((line) => line !== '');
}

test('repeated and concurrent signals produce one episode and one notification', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    const first = await acceptAlertSignal(pool, connector, signal, noon);
    assert.equal(first.outcome, 'opened');

    const replay = await acceptAlertSignal(pool, connector, signal, noon);
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(replay.episodeId, first.episodeId);

    const second = await acceptAlertSignal(pool, connector, { ...signal, signalId: 'sig-0002' }, noon);
    assert.equal(second.outcome, 'coalesced');
    assert.equal(second.deliveryId, null);

    const concurrent = await Promise.all([
      acceptAlertSignal(pool, connector, { ...signal, signalId: 'sig-0003' }, noon),
      acceptAlertSignal(pool, connector, { ...signal, signalId: 'sig-0003' }, noon),
    ]);
    assert.deepEqual(concurrent.map((result) => result.outcome).sort(), ['coalesced', 'duplicate']);

    assert.equal(await count('notification_episode'), '1');
    assert.equal(await count('notification_outbox'), '1');
    assert.equal(await count('notification_signal'), '3');
    assert.equal(await scalar('SELECT signal_count FROM notification_episode'), '3');

    const adapter = sink(path);
    const worker = dispatcher(pool, adapter);
    await worker.recoverAfterRestart();
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['delivered']);
    assert.deepEqual(await worker.dispatchDue(), []);
    assert.equal(await count("notification_outbox WHERE status='delivered'"), '1');
    const ledger = await adapter.ledger();
    assert.equal(Object.keys(ledger.receipts).length, 1);
    assert.equal(ledger.deliverCalls, 1);
    assert.deepEqual(await attempts(), ['lookup:not_found', 'send:delivered']);
  } finally { await pool.end(); }
});

test('concurrent first signals for one new condition coalesce into one episode in the database', async () => {
  const pool = await seed();
  try {
    // Distinct identities, same brand-new condition, no state row yet: both transactions start by
    // creating the per-installation lock row, and exactly one may open the episode.
    const results = await Promise.all(['sig-a', 'sig-b', 'sig-c', 'sig-d'].map((signalId) =>
      acceptAlertSignal(pool, connector, { ...signal, signalId }, noon)));
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['coalesced', 'coalesced', 'coalesced', 'opened']);
    assert.equal(new Set(results.map((r) => r.episodeId)).size, 1);
    assert.equal(await count('notification_episode'), '1');
    assert.equal(await count('notification_outbox'), '1');
    assert.equal(await scalar('SELECT signal_count || \'|\' || episode_ref FROM notification_episode'), '4|ep-1');
    assert.equal(await scalar('SELECT episode_sequence FROM notification_alert_state'), '1');
  } finally { await pool.end(); }
});

// Regression, finding E1. The lane kept "one open episode per condition" only inside a JSON state
// document; the episode table accepted a second open episode for the same condition.
test('the database refuses a second open episode for one condition', async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await assert.rejects(sql(`INSERT INTO notification_episode(installation_id,organisation_id,branch_id,episode_ref,
      condition_key,severity,status,opened_at,last_signal_at,signal_count)
      VALUES ('${ids.installation}','${ids.a}','${ids.branchA}','ep-99','${signal.conditionKey}','actionable','open',
      '2026-09-12T12:00:00Z','2026-09-12T12:00:00Z',1)`), /notification_episode_one_open/);
    assert.equal(await count('notification_episode'), '1');
  } finally { await pool.end(); }
});

test('a changed payload under a reused signal identity is refused and writes nothing', async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const before = await sql('SELECT signal_count, last_signal_at FROM notification_episode');
    await assert.rejects(
      acceptAlertSignal(pool, connector, { ...signal, detail: 'On hand 1 of target 10' }, noon),
      rejectsWith('CONFLICTING_SIGNAL'),
    );
    assert.equal(await count('notification_signal'), '1');
    assert.equal(await count('notification_episode'), '1');
    assert.equal(await sql('SELECT signal_count, last_signal_at FROM notification_episode'), before);
  } finally { await pool.end(); }
});

// Regression, finding E2 (database half). Resolved episodes filled the lane's 2000-entry document for
// good, and no resolution path existed at all, so a condition that recovered and recurred was never
// notified again.
test('resolving a condition lets it open a new episode, and only open episodes occupy capacity', async () => {
  const pool = await seed();
  try {
    const first = await acceptAlertSignal(pool, connector, signal, noon);
    const resolved = await resolveAlertEpisode(pool, connector, signal.conditionKey, at('2026-09-12T12:30:00.000Z'));
    assert.deepEqual(resolved, { outcome: 'resolved', episodeId: first.episodeId });
    assert.deepEqual(
      await resolveAlertEpisode(pool, connector, signal.conditionKey, at('2026-09-12T12:31:00.000Z')),
      { outcome: 'not_open', episodeId: null },
    );

    const recurred = await acceptAlertSignal(
      pool, connector, { ...signal, signalId: 'sig-recur', observedAt: '2026-09-12T13:00:00.000Z' },
      at('2026-09-12T13:00:00.000Z'),
    );
    assert.equal(recurred.outcome, 'opened');
    assert.notEqual(recurred.episodeId, first.episodeId);
    assert.notEqual(recurred.deliveryId, null);
    assert.equal(await scalar("SELECT string_agg(episode_ref || ':' || status, ',' ORDER BY episode_ref) FROM notification_episode"),
      'ep-1:resolved,ep-2:open');
    assert.equal(await count('notification_outbox'), '2');

    // Two thousand resolved conditions of history do not block a new one.
    await sql(`UPDATE notification_alert_state SET episode_sequence=2002;
      INSERT INTO notification_episode(installation_id,organisation_id,branch_id,episode_ref,condition_key,severity,status,
        opened_at,last_signal_at,resolved_at,signal_count)
      SELECT '${ids.installation}','${ids.a}','${ids.branchA}','ep-'||(n+2),'history-'||n,'actionable','resolved',
        '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-02T00:00:00Z',1 FROM generate_series(1,2000) n`);
    const fresh = await acceptAlertSignal(pool, connector,
      { ...signal, signalId: 'sig-new', conditionKey: `${ids.installation}:00018` }, noon);
    assert.equal(fresh.outcome, 'opened');
    assert.equal(await scalar("SELECT episode_ref FROM notification_episode WHERE condition_key LIKE '%:00018'"), 'ep-2003');

    // Two thousand open conditions do: a new condition is refused, an open one still coalesces.
    await sql(`UPDATE notification_episode SET status='open', resolved_at=NULL WHERE condition_key LIKE 'history-%'`);
    await assert.rejects(
      acceptAlertSignal(pool, connector, { ...signal, signalId: 'sig-full', conditionKey: `${ids.installation}:00019` }, noon),
      rejectsWith('SIGNAL_REFUSED', 'episode_capacity_exceeded'),
    );
    const stillTracked = await acceptAlertSignal(pool, connector,
      { ...signal, signalId: 'sig-again', conditionKey: `${ids.installation}:00018` }, noon);
    assert.equal(stillTracked.outcome, 'coalesced');
  } finally { await pool.end(); }
});

test('quiet hours follow the branch time zone and the stored policy, not the server clock', async () => {
  const pool = await seed();
  try {
    const deferred = await acceptAlertSignal(pool, connector, { ...signal, observedAt: '2026-09-12T20:30:00.000Z' }, night);
    assert.equal(deferred.outcome, 'opened');
    assert.equal(deferred.deliverAt, '2026-09-13T04:00:00.000Z');

    const bypass = await acceptAlertSignal(
      pool, connector,
      { ...signal, signalId: 'sig-critical', conditionKey: `${ids.installation}:00018`, severity: 'critical', observedAt: '2026-09-12T20:30:00.000Z' },
      night,
    );
    assert.equal(bypass.deliverAt, '2026-09-12T20:30:00.000Z');

    // Changing the branch zone changes the schedule, which proves the zone is read from the branch.
    await sql(`UPDATE branch SET timezone='Europe/London' WHERE id='${ids.branchA}'`);
    const london = await acceptAlertSignal(
      pool, connector,
      { ...signal, signalId: 'sig-london', conditionKey: `${ids.installation}:00019`, observedAt: '2026-09-12T20:30:00.000Z' },
      night,
    );
    // 21:30 in London is outside a 22:00 window, so this one is immediate.
    assert.equal(london.deliverAt, '2026-09-12T20:30:00.000Z');
  } finally { await pool.end(); }
});

test('a deferred delivery survives a restart and fires exactly once at the scheduled instant', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    const deferred = await acceptAlertSignal(pool, connector, { ...signal, observedAt: '2026-09-12T20:30:00.000Z' }, night);
    assert.equal(deferred.deliverAt, '2026-09-13T04:00:00.000Z');

    const adapter = sink(path);
    const early = dispatcher(pool, adapter, at('2026-09-13T03:59:59.999Z'));
    await early.recoverAfterRestart();
    assert.deepEqual(await early.dispatchDue(), []);
    assert.equal(await scalar('SELECT status || \'|\' || deferrals FROM notification_outbox'), 'pending|0');

    // The first process is gone. Two fresh workers come up at the scheduled instant and race.
    const due = at('2026-09-13T04:00:00.000Z');
    const workers = [dispatcher(pool, sink(path), due), dispatcher(pool, sink(path), due)];
    for (const worker of workers) assert.equal((await worker.recoverAfterRestart()).unresolved, 0);
    const passes = await Promise.all(workers.map((worker) => worker.dispatchDue()));
    assert.deepEqual(passes.flat().map((r) => r.status), ['delivered']);

    const later = dispatcher(pool, sink(path), at('2026-09-13T04:05:00.000Z'));
    await later.recoverAfterRestart();
    assert.deepEqual(await later.dispatchDue(), []);
    const ledger = await adapter.ledger();
    assert.equal(ledger.deliverCalls, 1);
    assert.equal(Object.keys(ledger.receipts).length, 1);
    assert.equal(await scalar("SELECT status || '|' || deferrals || '|' || to_char(deliver_at AT TIME ZONE 'UTC','HH24:MI') FROM notification_outbox"),
      'delivered|0|04:00');
  } finally { await pool.end(); }
});

test('a delivery that comes due inside the quiet window is re-deferred rather than sent', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    const scheduled = await acceptAlertSignal(pool, connector, signal, noon);
    assert.equal(scheduled.deliverAt, '2026-09-12T11:59:00.000Z');
    const adapter = sink(path);
    const worker = dispatcher(pool, adapter, night);
    await worker.recoverAfterRestart();
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['deferred']);
    assert.equal(Object.keys((await adapter.ledger()).receipts).length, 0);
    assert.equal(await scalar("SELECT to_char(deliver_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') || '|' || deferrals FROM notification_outbox"),
      '2026-09-13 04:00|1');
    assert.deepEqual(await attempts(), [], 'a deferral is not a sink attempt');
  } finally { await pool.end(); }
});

test('an unusable policy records the episode and never schedules an immediate delivery', async () => {
  const pool = await seed(false);
  try {
    const missing = await acceptAlertSignal(pool, connector, signal, noon);
    assert.equal(missing.outcome, 'suppressed');
    assert.equal(missing.reason, 'policy_missing');
    assert.equal(missing.deliveryId, null);
    assert.equal(await count('notification_outbox'), '0');
    assert.equal(await scalar("SELECT suppressed_reason FROM notification_episode WHERE status='open'"), 'policy_missing');

    await sql(`INSERT INTO notification_policy(organisation_id,branch_id,status,quiet_hours_enabled,
      quiet_start_minute,quiet_end_minute) VALUES ('${ids.a}','${ids.branchA}','active',true,1320,420)`);
    await sql(`UPDATE branch SET timezone='Mars/Olympus' WHERE id='${ids.branchA}'`);
    const unusable = await acceptAlertSignal(
      pool, connector, { ...signal, signalId: 'sig-tz', conditionKey: `${ids.installation}:00018` }, noon,
    );
    assert.equal(unusable.reason, 'invalid_time_zone');
    assert.equal(await count('notification_outbox'), '0');
  } finally { await pool.end(); }
});

test('an accepted delivery whose answer is lost is resolved by lookup, not by sending again', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const lossy = sink(path, 'timeout_after_accept');
    const first = dispatcher(pool, lossy);
    await first.recoverAfterRestart();
    assert.deepEqual((await first.dispatchDue()).map((r) => r.status), ['outcome_unknown']);
    assert.equal(await scalar("SELECT status || '|' || (lease_expires_at IS NULL) FROM notification_outbox"), 'outcome_unknown|true');
    assert.equal(Object.keys((await lossy.ledger()).receipts).length, 1);

    const healthy = sink(path);
    const restarted = dispatcher(pool, healthy);
    assert.deepEqual(await restarted.recoverAfterRestart(), { reconciled: 1, unresolved: 0, leased: 0, more: false });
    assert.equal(await count("notification_outbox WHERE status='delivered'"), '1');
    const ledger = await healthy.ledger();
    assert.equal(Object.keys(ledger.receipts).length, 1, 'no second notification was created');
    assert.equal(ledger.deliverCalls, 1);
    assert.deepEqual(await attempts(), ['lookup:not_found', 'send:failed', 'lookup:found']);
  } finally { await pool.end(); }
});

// Regression, finding C1. The lane's recovery looked up a row a live worker was still sending, found
// nothing yet, and demoted it to outcome_unknown (and to manual_review on a second pass).
test('a recovering worker leaves a delivery with a live lease alone and stays paused', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const pausing = new PausingSink(sink(path));
    const sender = dispatcher(pool, pausing, noon, { sinkTimeoutMs: 20_000 });
    await sender.recoverAfterRestart();
    const sending = sender.dispatchDue();
    await pausing.reached;

    const recovering = dispatcher(pool, sink(path));
    assert.deepEqual(await recovering.recoverAfterRestart(), { reconciled: 0, unresolved: 0, leased: 1, more: false });
    assert.equal(recovering.dispatchEnabled, false);
    assert.deepEqual(await recovering.dispatchDue(), []);
    assert.equal(await scalar('SELECT status FROM notification_outbox'), 'dispatching');

    pausing.release();
    assert.deepEqual((await sending).map((r) => r.status), ['delivered']);
    assert.deepEqual(await recovering.recoverAfterRestart(), { reconciled: 0, unresolved: 0, leased: 0, more: false });
    assert.equal(recovering.dispatchEnabled, true);
    const ledger = await sink(path).ledger();
    assert.equal(ledger.deliverCalls, 1);
    assert.equal(ledger.lookupCalls, 1, 'only the sender looked up, before its own send');
  } finally { await pool.end(); }
});

// Regression, finding C2. A worker that died after claiming but before sending left the row
// dispatching; the lane escalated it to manual_review and the notification was never sent.
test('an abandoned claim that never sent is released after its lease and delivered once', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await sql("UPDATE notification_outbox SET status='dispatching', lease_expires_at='2026-09-12T12:01:00Z', version=version+1");
    const adapter = sink(path);
    const worker = dispatcher(pool, adapter, at('2026-09-12T12:05:00.000Z'));
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 1, unresolved: 0, leased: 0, more: false });
    assert.equal(await scalar("SELECT status || '|' || last_reason FROM notification_outbox"), 'pending|claim_abandoned');
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['delivered']);
    assert.equal((await adapter.ledger()).deliverCalls, 1);
  } finally { await pool.end(); }
});

test('an expired send with no sink record becomes unknown, then manual review, and is never resent', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await sql(`UPDATE notification_outbox SET status='dispatching', lease_expires_at='2026-09-12T12:01:00Z', version=version+1;
      INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at)
      SELECT id,installation_id,organisation_id,branch_id,'send','2026-09-12T12:00:30Z' FROM notification_outbox`);
    const adapter = sink(path);
    const worker = dispatcher(pool, adapter, at('2026-09-12T12:05:00.000Z'));
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 0, unresolved: 1, leased: 0, more: false });
    assert.equal(await scalar("SELECT status || '|' || last_reason FROM notification_outbox"), 'outcome_unknown|lease_expired_unsettled');
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 1, unresolved: 0, leased: 0, more: false });
    assert.equal(await scalar("SELECT status || '|' || last_reason FROM notification_outbox"), 'manual_review|not_found_after_unknown');
    assert.deepEqual(await worker.dispatchDue(), []);
    assert.equal((await adapter.ledger()).deliverCalls, 0);
    assert.deepEqual(await attempts(), ['send:abandoned', 'lookup:not_found', 'lookup:not_found']);
  } finally { await pool.end(); }
});

// Regression, finding D1. The lane sent a never-attempted row without asking the sink. A database
// restored from before a delivery holds that row as pending, and a provider without idempotent
// accept would push it a second time.
test('a restored pending delivery the sink already holds is settled by lookup, not sent again', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    const accepted = await acceptAlertSignal(pool, connector, signal, noon);
    const stored = sealDeliveryPayload(JSON.parse(await scalar('SELECT payload::text FROM notification_outbox')) as SafeDeliveryPayload);
    const previousLife = await sink(path).deliver(accepted.deliveryId!, stored);

    const adapter = sink(path);
    const worker = dispatcher(pool, adapter);
    await worker.recoverAfterRestart();
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['delivered']);
    assert.equal(await scalar('SELECT receipt_id FROM notification_outbox'), previousLife.receiptId);
    assert.equal((await adapter.ledger()).deliverCalls, 1, 'only the delivery from before the restore');
    assert.deepEqual(await attempts(), ['lookup:found']);
  } finally { await pool.end(); }
});

// Regression, finding R2. The lane awaited the sink with no deadline, so a provider that never
// answered held the worker forever.
test('a sink that never answers is abandoned within its bound and the attempt is recorded', { timeout: 30_000 }, async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const hanging = new HangingSink(sink(path));
    // The deadline leaves the real file-backed lookup ample time, including on Windows, so only the
    // hanging send can be the call that times out.
    const worker = dispatcher(pool, hanging, noon, { leaseMs: 5_000, sinkTimeoutMs: 1_000 });
    await worker.recoverAfterRestart();
    const started = process.hrtime.bigint();
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['outcome_unknown']);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 10_000);
    assert.equal(hanging.deliverCalls, 1);
    assert.deepEqual(await attempts(), ['lookup:not_found', 'send:timed_out']);
    assert.equal(await scalar("SELECT status || '|' || last_reason FROM notification_outbox"), 'outcome_unknown|timed_out');
  } finally { await pool.end(); }
});

// Regression, finding R1. A lookup that kept failing left the lane's row outcome_unknown forever,
// asked again on every pass, with nothing recording how often.
test('failed lookups are recorded and bounded, then escalated for a person', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await sql("UPDATE notification_outbox SET status='outcome_unknown', version=version+1");
    await writeFile(`${path}.lock`, JSON.stringify({ owner: 'crashed-holder', pid: 1 }));
    const blind = new SyntheticFileDeliverySink({ path, clock: noon, lockWaitMs: 0, lockPollMs: 1 });
    const worker = dispatcher(pool, blind);
    for (let pass = 1; pass < MAX_LOOKUP_FAILURES; pass += 1) {
      assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 0, unresolved: 1, leased: 0, more: false }, `pass ${pass}`);
    }
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 1, unresolved: 0, leased: 0, more: false });
    assert.equal(await scalar("SELECT status || '|' || last_reason FROM notification_outbox"), 'manual_review|lookup_attempts_exhausted');
    assert.equal(await count("notification_delivery_attempt WHERE kind='lookup' AND outcome='failed'"), String(MAX_LOOKUP_FAILURES));
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 0, unresolved: 0, leased: 0, more: false });
    assert.equal(await count('notification_delivery_attempt'), String(MAX_LOOKUP_FAILURES), 'a settled row is not asked again');
  } finally { await pool.end(); }
});

test('dispatch stays paused while an unsettled delivery cannot be reconciled', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await sql(`UPDATE notification_outbox SET status='dispatching', lease_expires_at='2026-09-12T11:59:30Z', version=version+1;
      INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at)
      SELECT id,installation_id,organisation_id,branch_id,'send','2026-09-12T11:59:10Z' FROM notification_outbox`);
    await writeFile(`${path}.lock`, JSON.stringify({ owner: 'crashed-holder', pid: 1 }));
    const blind = new SyntheticFileDeliverySink({ path, clock: noon, lockWaitMs: 20, lockPollMs: 5 });
    const worker = dispatcher(pool, blind);
    assert.deepEqual(await worker.recoverAfterRestart(), { reconciled: 0, unresolved: 1, leased: 0, more: false });
    assert.equal(worker.dispatchEnabled, false);
    assert.deepEqual(await worker.dispatchDue(), []);
    assert.equal(await count("notification_outbox WHERE status='delivered'"), '0');
    assert.equal(await count("notification_outbox WHERE status='dispatching'"), '1');
  } finally { await pool.end(); }
});

test('the delivery payload carries no product, branch or quantity detail', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const stored = await sql('SELECT payload::text FROM notification_outbox');
    for (const secret of [signal.subject, signal.detail, signal.conditionKey, '00017', 'Synthetic A']) {
      assert.equal(stored.toLowerCase().includes(secret.toLowerCase()), false, `leaked ${secret}`);
    }
    assert.equal(
      await scalar("SELECT count(*) FROM notification_outbox, jsonb_object_keys(payload) k WHERE k NOT IN ('episodeId','installationId','title','body')"),
      '0',
    );

    const adapter = sink(path);
    const worker = dispatcher(pool, adapter);
    await worker.recoverAfterRestart();
    await worker.dispatchDue();
    const receipts = JSON.stringify(await adapter.ledger());
    for (const secret of [signal.subject, signal.detail, '00017']) assert.equal(receipts.includes(secret), false);
  } finally { await pool.end(); }
});

// Regressions, findings P1 and P3. The lane's constraint allowed any title and body up to a length,
// and a JSON null identifier made its comparison NULL, which a CHECK treats as passing.
test('the outbox constraint refuses anything but a redacted template naming its own identity', async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    for (const change of [
      `payload||'{"productName":"SYN-INVENTORY-PACK"}'::jsonb`,
      `jsonb_set(payload,'{title}','"SYN-INVENTORY-PACK is low"')`,
      `jsonb_set(payload,'{body}','"On hand 2 of target 10"')`,
      `jsonb_set(payload,'{episodeId}','null')`,
      `jsonb_set(payload,'{installationId}','null')`,
      `jsonb_set(payload,'{title}','null')`,
    ]) {
      await assert.rejects(sql(`UPDATE notification_outbox SET payload=${change}`), /notification_outbox_payload_shape/, change);
    }
  } finally { await pool.end(); }
});

// Regression, finding P2. The lane refused a safe payload whenever signal text occurred inside the
// fixed template, and the refusal rolled back the whole acceptance: the alert was lost.
test('signal text that happens to occur in the fixed template does not lose the alert', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    const accepted = await acceptAlertSignal(pool, connector, {
      ...signal, subject: 'PharmaCart', detail: 'Open PharmaCart to review this alert.', conditionKey: `${ids.installation}:review`,
    }, noon);
    assert.equal(accepted.outcome, 'opened');
    const worker = dispatcher(pool, sink(path));
    await worker.recoverAfterRestart();
    assert.deepEqual((await worker.dispatchDue()).map((r) => r.status), ['delivered']);
  } finally { await pool.end(); }
});

test('one tenant cannot see or deliver another tenant notification', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await acceptAlertSignal(pool, otherConnector, {
      ...signal, conditionKey: `${installationB}:00017`, subject: 'SYN-B-PRIVATE',
    }, noon);
    assert.equal(await count('notification_outbox'), '2');

    const adapter = sink(path);
    const worker = dispatcher(pool, adapter);
    await worker.recoverAfterRestart();
    assert.equal((await worker.dispatchDue()).length, 1);
    assert.equal(await count(`notification_outbox WHERE branch_id='${ids.branchA}' AND status='delivered'`), '1');
    assert.equal(await count(`notification_outbox WHERE branch_id='${ids.branchB}' AND status='pending'`), '1');
    assert.equal(JSON.stringify(await adapter.ledger()).includes('SYN-B-PRIVATE'), false);

    const visible = await asRuntime(pool, ids.a, ids.branchA, async (client) => {
      const tables = ['notification_policy', 'notification_alert_state', 'notification_episode', 'notification_signal',
        'notification_outbox', 'notification_delivery_attempt'];
      const counts: Record<string, string> = {};
      for (const table of tables) counts[table] = (await client.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n;
      return counts;
    });
    assert.deepEqual(visible, {
      notification_policy: '1', notification_alert_state: '1', notification_episode: '1', notification_signal: '1',
      notification_outbox: '1', notification_delivery_attempt: '2',
    });

    // A dispatcher scoped to branch A cannot move branch B's row even by identifier.
    const otherRow = await scalar(`SELECT id FROM notification_outbox WHERE branch_id='${ids.branchB}'`);
    const moved = await asRuntime(pool, ids.a, ids.branchA, async (client) =>
      (await client.query("UPDATE notification_outbox SET status='held' WHERE id=$1", [otherRow])).rowCount);
    assert.equal(moved, 0);
  } finally { await pool.end(); }
});

// Regression, finding T1. A foreign key check ignores row level security. The lane referenced an
// episode by id alone, so a writer in tenant A could attach rows to tenant B's episode (and learn
// whether an identifier exists) by naming it.
test('a writer in one tenant cannot attach evidence to another tenant episode or delivery', async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    await acceptAlertSignal(pool, otherConnector, { ...signal, conditionKey: `${installationB}:00017` }, noon);
    const otherEpisode = await scalar(`SELECT id FROM notification_episode WHERE branch_id='${ids.branchB}'`);
    const otherDelivery = await scalar(`SELECT id FROM notification_outbox WHERE branch_id='${ids.branchB}'`);

    await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(
      `INSERT INTO notification_signal(installation_id,signal_id,organisation_id,branch_id,fingerprint,episode_id,accepted_at)
       VALUES($1,'forged',$2,$3,repeat('a',64),$4,'2026-09-12T12:00:00Z')`,
      [ids.installation, ids.a, ids.branchA, otherEpisode])), /foreign key/);
    await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(
      `INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at,outcome)
       VALUES($1,$2,$3,$4,'lookup','2026-09-12T12:00:00Z','not_found')`,
      [otherDelivery, ids.installation, ids.a, ids.branchA])), /foreign key/);
    assert.equal(await count('notification_signal'), '2');
    assert.equal(await count('notification_delivery_attempt'), '0');
  } finally { await pool.end(); }
});

test('a revoked installation cannot accept or resolve an alert', async () => {
  const pool = await seed();
  try {
    await sql(`UPDATE connector_installation SET status='revoked' WHERE id='${ids.installation}'`);
    await assert.rejects(acceptAlertSignal(pool, connector, signal, noon), rejectsWith('INSTALLATION_DENIED'));
    await assert.rejects(resolveAlertEpisode(pool, connector, signal.conditionKey, noon), rejectsWith('INSTALLATION_DENIED'));
    assert.equal(await count('notification_episode'), '0');
    assert.equal(await count('notification_signal'), '0');
    assert.equal(await count('notification_alert_state'), '0');
  } finally { await pool.end(); }
});

test('the runtime login cannot write policy, delete evidence or rewrite a recorded attempt', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const worker = dispatcher(pool, sink(path));
    await worker.recoverAfterRestart();
    await worker.dispatchDue();

    await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(
      `UPDATE notification_policy SET quiet_start_minute=0 WHERE organisation_id='${ids.a}'`)), /permission denied/);
    for (const table of ['notification_outbox', 'notification_episode', 'notification_signal', 'notification_delivery_attempt']) {
      await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(`DELETE FROM ${table}`)), /permission denied/, table);
    }
    await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(
      "UPDATE notification_delivery_attempt SET outcome='failed' WHERE kind='send'")), /already recorded/);
    await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(
      "UPDATE notification_delivery_attempt SET kind='lookup'")), /permission denied/);
    assert.equal(await count('notification_outbox'), '1');
    assert.deepEqual(await attempts(), ['lookup:not_found', 'send:delivered']);
  } finally { await pool.end(); }
});

// Review finding G1. The runtime held table-wide UPDATE on the outbox, the episode and the lock row, so a
// request path defect could re-point a delivery at another episode or rewrite what it will say.
test('the runtime login may update only the columns delivery writes', async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const payloadBefore = await scalar('SELECT payload::text FROM notification_outbox');
    for (const statement of [
      "UPDATE notification_outbox SET payload=payload",
      "UPDATE notification_outbox SET severity='critical'",
      'UPDATE notification_outbox SET episode_id=episode_id',
      'UPDATE notification_outbox SET installation_id=installation_id',
      "UPDATE notification_episode SET condition_key='other'",
      "UPDATE notification_episode SET episode_ref='ep-9'",
      'UPDATE notification_episode SET opened_at=opened_at',
      "UPDATE notification_episode SET suppressed_reason='x'",
      'UPDATE notification_alert_state SET branch_id=branch_id',
    ]) {
      await assert.rejects(asRuntime(pool, ids.a, ids.branchA, (client) => client.query(statement)), /permission denied/, statement);
    }
    // The columns delivery does write stay writable, so the refusals above are about the column.
    assert.equal(await asRuntime(pool, ids.a, ids.branchA, async (client) =>
      (await client.query("UPDATE notification_outbox SET last_reason='probe', version=version+1")).rowCount), 1);
    assert.equal(await asRuntime(pool, ids.a, ids.branchA, async (client) =>
      (await client.query('UPDATE notification_episode SET signal_count=signal_count')).rowCount), 1);
    assert.equal(await scalar('SELECT payload::text FROM notification_outbox'), payloadBefore);
  } finally { await pool.end(); }
});

test('a delivered notification can never be re-queued', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const worker = dispatcher(pool, sink(path));
    await worker.recoverAfterRestart();
    await worker.dispatchDue();
    await assert.rejects(sql("UPDATE notification_outbox SET status='pending', receipt_id=NULL WHERE status='delivered'"), /terminal/);
    assert.equal(await count("notification_outbox WHERE status='delivered'"), '1');
    // Nor can a second send be authorised for it, whatever the code does.
    await assert.rejects(sql(`INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at)
      SELECT id,installation_id,organisation_id,branch_id,'send','2026-09-12T12:10:00Z' FROM notification_outbox`),
    /notification_delivery_attempt_one_send/);
  } finally { await pool.end(); }
});

// Regression, finding L1. The lane waited on the per-installation row lock with no bound.
test('acceptance waits a bounded time for the installation lock and writes nothing when it expires', { timeout: 30_000 }, async () => {
  const pool = await seed();
  try {
    await acceptAlertSignal(pool, connector, signal, noon);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SET LOCAL ROLE pharmacart_runtime');
      await holder.query("SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)", [ids.a, ids.branchA]);
      await holder.query('SELECT 1 FROM notification_alert_state WHERE installation_id=$1 FOR UPDATE', [ids.installation]);
      const started = process.hrtime.bigint();
      await assert.rejects(
        acceptAlertSignal(pool, connector, { ...signal, signalId: 'sig-locked', conditionKey: `${ids.installation}:00099` }, noon,
          { lockTimeoutMs: 200 }),
        rejectsWith('LOCK_TIMEOUT'),
      );
      assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 10_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    assert.equal(await count('notification_episode'), '1');
    assert.equal(await count('notification_signal'), '1');
  } finally { await pool.end(); }
});

test('malformed and oversized signals are refused before anything is written', async () => {
  const pool = await seed();
  try {
    for (const [overrides, reason] of [
      [{ signalId: '' }, 'invalid_identifier'],
      [{ signalId: 'x'.repeat(129) }, 'invalid_identifier'],
      [{ detail: 'x'.repeat(2049) }, 'signal_too_large'],
      [{ observedAt: '2026' }, 'invalid_instant'],
      [{ observedAt: '2026-07-01T00:00:00.000Z' }, 'stale_signal'],
      [{ observedAt: '2026-09-12T23:00:00.000Z' }, 'future_signal'],
    ] as const) {
      await assert.rejects(acceptAlertSignal(pool, connector, { ...signal, ...overrides }, noon), rejectsWith('SIGNAL_REFUSED', reason));
    }
    assert.equal(await count('notification_episode'), '0');
    assert.equal(await count('notification_alert_state'), '0');
    await assert.rejects(acceptAlertSignal(pool, connector, signal, noon, { lockTimeoutMs: 0 }), RangeError);
  } finally { await pool.end(); }
});

test('a synthetic sink is refused unless the caller acknowledges it', async (t) => {
  const pool = await seed();
  const path = await workspace(t);
  try {
    assert.throws(() => new NotificationDispatcher(
      pool, { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA },
      sink(path), noon, {},
    ), /SYNTHETIC_SINK_NOT_ACKNOWLEDGED/);
    assert.throws(() => dispatcher(pool, sink(path), noon, { leaseMs: 1_000, sinkTimeoutMs: 500 }), RangeError);
  } finally { await pool.end(); }
});
