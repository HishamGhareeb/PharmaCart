import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Pool } from 'pg';

import { deriveSnapshotEnvelope } from '../../feed-identity/src/snapshot-envelope.ts';
import { readFeedManifest } from '../../feed-ingestion/src/feed-manifest.ts';
import { completeSingleFileSnapshot } from '../../feed-ingestion/src/snapshot-completion.ts';
import { runFeedPass, type FeedSnapshotSink } from '../../../apps/worker/src/feed-worker.ts';
import {
  createFeedSnapshotSink,
  FeedSinkRefusalError,
  type FeedSinkOutcome,
  type FeedSinkSubmission,
} from '../src/feed-sink.ts';
import { ids, sql, resetDatabase } from './support.ts';

// PostgreSQL evidence for the transactional feed persistence sink. Every test
// runs against the disposable pharmacart_test database through the restricted
// runtime login, so forced row-level security and the append-only grant on
// feed_sequence_identity are the real ones, not a simulation.

const subjectA = 'synthetic:connector:a';
const subjectB = 'synthetic:connector:b';
const installationB = '50000000-0000-4000-8000-000000000002';
const T0 = '2026-09-12T06:30:00Z';
const lockMarker = 916017;

const later = (seconds: number, milliseconds = 0) =>
  new Date(Date.parse(T0) + seconds * 1000 + milliseconds).toISOString();
const secondOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const rows = (quantity = '8.25') => [
  { sourceCode: '00017', quantity, unit: 'box' },
  // Beyond float precision: any Number conversion on the way to PostgreSQL would change it.
  { sourceCode: '00018', quantity: '12345678901234567.125', unit: 'strip' },
];

function exportOf(overrides: Partial<FeedSinkSubmission> = {}): FeedSinkSubmission {
  return {
    batchKey: overrides.batchKey ?? 'synthetic-export-001',
    partitionKey: overrides.partitionKey ?? 'part-a',
    exportedAt: overrides.exportedAt ?? T0,
    rows: overrides.rows ?? rows(),
  };
}

const pair = (installation: string, organisation: string, branch: string, subject: string, status = 'active') =>
  sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status,paired_at,status_changed_at)
    VALUES ('${installation}','${organisation}','${branch}','${subject}','${status}',
      ${status === 'pending' ? 'NULL' : 'now()'},now())`);

const setStatus = (installation: string, status: string) =>
  sql(`UPDATE connector_installation SET status='${status}', status_changed_at=now() WHERE id='${installation}'`);

/** identity rows | inbox rows | projection rows | projection revision */
const counts = async (installation = ids.installation) =>
  (await sql(`SELECT (SELECT count(*) FROM feed_sequence_identity WHERE installation_id='${installation}')::text || '|' ||
    (SELECT count(*) FROM inventory_inbox WHERE installation_id='${installation}')::text || '|' ||
    (SELECT count(*) FROM inventory_projection WHERE installation_id='${installation}')::text || '|' ||
    (SELECT coalesce(max(revision),0) FROM inventory_state WHERE installation_id='${installation}')::text`)).trim();

function persisted(outcome: FeedSinkOutcome) {
  assert.equal(outcome.kind, 'persisted', outcome.kind === 'refused' ? `${outcome.reason}: ${outcome.detail}` : '');
  return outcome.kind === 'persisted' ? outcome.receipt : (undefined as never);
}

function refusedWith(outcome: FeedSinkOutcome, reason: string) {
  assert.equal(outcome.kind, 'refused', `expected refusal ${reason}, the export was persisted`);
  assert.equal(outcome.kind === 'refused' ? outcome.reason : '', reason);
}

async function waitFor(query: string, expected: string, what: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await sql(query)).trim() === expected) return;
    await delay(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const lockWaiters = `SELECT count(*) FROM pg_stat_activity WHERE datname='pharmacart_test' AND wait_event_type='Lock'`;

/**
 * Holds the per-installation inventory lock from a separate session so passes
 * started while it is held are guaranteed to overlap. Returned inside an object:
 * returning the bare promise from an async function would wait for it.
 */
async function holdInventoryLock(installation: string, seconds: number) {
  const released = sql(`BEGIN;
    SELECT revision FROM inventory_state WHERE installation_id='${installation}' FOR UPDATE;
    SELECT pg_advisory_xact_lock(${lockMarker});
    SELECT pg_sleep(${seconds});
    COMMIT;`);
  await waitFor(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=${lockMarker} AND granted`, '1',
    'the holding session to take its marker lock');
  return { released };
}

async function setup() {
  const pool = await resetDatabase();
  await pair(ids.installation, ids.a, ids.branchA, subjectA);
  // A shortage target the API path would turn into a need. The sink must not.
  await sql(`INSERT INTO inventory_target(installation_id,organisation_id,branch_id,source_code,product_ref,unit,target_quantity)
    VALUES('${ids.installation}','${ids.a}','${ids.branchA}','00017','SYN-INVENTORY-PACK','box',10)`);
  return pool;
}

function sinkFor(pool: Pool, subject = subjectA, lockTimeoutMs = 15_000) {
  return createFeedSnapshotSink({ pool, installationSubject: subject, lockTimeoutMs });
}

test('feed sink: a single-file export persists once, identity and projection included, and a re-read is a duplicate', async () => {
  const pool = await setup();
  try {
    const sink = sinkFor(pool);
    const submission = exportOf();
    const receipt = persisted(await sink.persist(submission));

    const derived = deriveSnapshotEnvelope({ installationId: ids.installation, ...submission }, null);
    assert.equal(derived.kind, 'derived');
    const envelope = derived.kind === 'derived' ? derived.envelope : (undefined as never);
    assert.deepEqual(receipt, {
      eventId: envelope.eventId,
      completionEventId: completeSingleFileSnapshot(envelope).eventId,
      snapshotId: envelope.snapshotId,
      partitionId: envelope.partitionId,
      sequence: secondOf(T0),
      duplicate: false,
      projectionRevision: 1,
    });
    assert.equal(await counts(), '1|2|2|1');

    // The identity row records exactly what claimed the second, under the stored tenant scope.
    assert.equal((await sql(`SELECT installation_id::text || '|' || sequence::text || '|' || batch_key || '|' || partition_key || '|' ||
      organisation_id::text || '|' || branch_id::text || '|' || content_digest || '|' || snapshot_id || '|' || event_id
      FROM feed_sequence_identity`)).trim(),
    [ids.installation, secondOf(T0), 'synthetic-export-001', 'part-a', ids.a, ids.branchA,
      derived.kind === 'derived' ? derived.contentDigest : '', envelope.snapshotId, envelope.eventId].join('|'));
    assert.equal((await sql(`SELECT string_agg(event_id, ',' ORDER BY event_id) FROM inventory_inbox`)).trim(),
      [receipt.completionEventId, receipt.eventId].sort().join(','));

    // Exact decimals survive to the projection; nothing is rounded through a float.
    assert.equal((await sql(`SELECT string_agg(source_code || '=' || quantity::text || ':' || unit || ':' || stale::text || ':' || snapshot_id || ':' || sequence::text, ',' ORDER BY source_code)
      FROM inventory_projection`)).trim(),
    `00017=8.25:box:false:${envelope.snapshotId}:${secondOf(T0)},00018=12345678901234567.125:strip:false:${envelope.snapshotId}:${secondOf(T0)}`);

    // No need recalculation is triggered by a landed snapshot: the two seeded needs
    // are the only ones, and no alert is raised for the 8.25 < 10 shortage.
    assert.equal((await sql('SELECT count(*) FROM need')).trim(), '2');
    assert.equal((await sql('SELECT count(*) FROM inventory_alert')).trim(), '0');

    // Re-reading the same export, rows in another order, is a replay.
    const replay = persisted(await sink.persist(exportOf({ rows: [...rows()].reverse() })));
    assert.deepEqual(replay, { ...receipt, duplicate: true });
    assert.equal(await counts(), '1|2|2|1');

    // The worker-facing adapter returns the same receipt.
    assert.deepEqual(await sink.ingest(submission), { ...receipt, duplicate: true });

    // A later export is a new snapshot and advances the projection exactly once.
    const next = persisted(await sink.persist(exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60), rows: rows('7') })));
    assert.equal(next.duplicate, false);
    assert.equal(next.projectionRevision, 2);
    assert.equal(next.sequence, secondOf(T0) + 60);
    assert.equal(await counts(), '2|4|2|2');
    assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(), '7');

    // The first export dropped again is older than the accepted watermark.
    refusedWith(await sink.persist(submission), 'stale_export');
    await assert.rejects(sink.ingest(submission),
      (error: unknown) => error instanceof FeedSinkRefusalError && error.code === 'stale_export');
    assert.equal(await counts(), '2|4|2|2');
    assert.equal((await sql('SELECT count(*) FROM need')).trim(), '2');
  } finally { await pool.end(); }
});

test('feed sink: anything other than a replay at an already-claimed second is refused by name', async () => {
  const pool = await setup();
  try {
    await pair(installationB, ids.b, ids.branchB, subjectB);
    const sink = sinkFor(pool);
    const original = persisted(await sink.persist(exportOf()));
    const digest = (await sql('SELECT content_digest FROM feed_sequence_identity')).trim();
    assert.equal(await counts(), '1|2|2|1');

    // Same batch and partition, same second, different stock.
    refusedWith(await sink.persist(exportOf({ exportedAt: later(0, 400), rows: rows('9') })), 'changed_content_same_sequence');
    // A second export at the same second under another batch key: never collapsed into the
    // existing snapshot and never reported as a stale sequence, whether or not its content matches.
    refusedWith(await sink.persist(exportOf({ batchKey: 'synthetic-export-001b' })), 'changed_batch_same_sequence');
    refusedWith(await sink.persist(exportOf({ batchKey: 'synthetic-export-001b', rows: rows('9') })), 'changed_batch_same_sequence');
    // Same batch, another partition key, at a second whose single-file snapshot is complete.
    refusedWith(await sink.persist(exportOf({ partitionKey: 'part-b' })), 'changed_partition_same_sequence');

    await assert.rejects(sink.ingest(exportOf({ batchKey: 'synthetic-export-001b' })),
      (error: unknown) => error instanceof FeedSinkRefusalError && error.code === 'changed_batch_same_sequence');

    // Nothing moved, and the evidence the refusals were made against is intact.
    assert.equal(await counts(), '1|2|2|1');
    assert.equal((await sql('SELECT content_digest FROM feed_sequence_identity')).trim(), digest);
    assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(), '8.25');
    assert.equal(persisted(await sink.persist(exportOf())).duplicate, true);
    assert.equal(persisted(await sink.persist(exportOf())).eventId, original.eventId);

    // Identity is scoped to the installation: another pharmacy exporting the same batch key
    // in the same second is unrelated and is accepted.
    const other = persisted(await sinkFor(pool, subjectB).persist(exportOf()));
    assert.equal(other.duplicate, false);
    assert.notEqual(other.snapshotId, original.snapshotId);
    assert.equal(await counts(installationB), '1|2|2|1');
    assert.equal(await counts(), '1|2|2|1');
  } finally { await pool.end(); }
});

test('feed sink: pending, suspended, revoked and unknown installations are refused by name and nothing is persisted', async () => {
  const pool = await resetDatabase();
  try {
    await pair(ids.installation, ids.a, ids.branchA, subjectA, 'pending');
    const sink = sinkFor(pool);
    const stateRows = async () => (await sql(`SELECT count(*) FROM inventory_state`)).trim();

    refusedWith(await sink.persist(exportOf()), 'pairing_incomplete');
    assert.equal(await counts(), '0|0|0|0');
    assert.equal(await stateRows(), '0');

    await sql(`UPDATE connector_installation SET status='active', paired_at=now(), status_changed_at=now() WHERE id='${ids.installation}'`);
    await setStatus(ids.installation, 'suspended');
    refusedWith(await sink.persist(exportOf()), 'installation_suspended');
    assert.equal(await counts(), '0|0|0|0');
    assert.equal(await stateRows(), '0');

    await setStatus(ids.installation, 'active');
    assert.equal(persisted(await sink.persist(exportOf())).duplicate, false);
    assert.equal(await counts(), '1|2|2|1');

    await setStatus(ids.installation, 'revoked');
    refusedWith(await sink.persist(exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60) })), 'installation_revoked');
    // A replay is refused too: a revoked identity is granted nothing.
    refusedWith(await sink.persist(exportOf()), 'installation_revoked');
    await assert.rejects(sink.ingest(exportOf()),
      (error: unknown) => error instanceof FeedSinkRefusalError && error.code === 'installation_revoked');
    assert.equal(await counts(), '1|2|2|1');

    // A subject with no paired installation, including a human member, is refused.
    refusedWith(await sinkFor(pool, 'synthetic:connector:unpaired').persist(exportOf()), 'installation_unknown');
    refusedWith(await sinkFor(pool, 'synthetic:user:a').persist(exportOf()), 'installation_unknown');
    assert.equal((await sql('SELECT count(*) FROM feed_sequence_identity')).trim(), '1');
  } finally { await pool.end(); }
});

test('feed sink: two passes submitting the same export at the same moment yield one identity and one projection update', async () => {
  const pool = await setup();
  try {
    const sink = sinkFor(pool);
    persisted(await sink.persist(exportOf()));
    assert.equal(await counts(), '1|2|2|1');

    const submission = exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60), rows: rows('6') });
    const hold = await holdInventoryLock(ids.installation, 6);
    const passes = [sink.persist(submission), sink.persist(submission)];
    await waitFor(lockWaiters, '2', 'both passes to queue on the inventory lock');
    await hold.released;
    const outcomes = await Promise.all(passes);

    const receipts = outcomes.map(persisted);
    assert.deepEqual(receipts.map((receipt) => receipt.duplicate).sort(), [false, true]);
    assert.equal(receipts[0]!.eventId, receipts[1]!.eventId);
    assert.deepEqual(receipts.map((receipt) => receipt.projectionRevision), [2, 2]);
    assert.equal(await counts(), '2|4|2|2');
    assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(), '6');
  } finally { await pool.end(); }
});

test('feed sink: conflicting exports racing for one second produce one accepted identity and one named refusal', async () => {
  const pool = await setup();
  try {
    const sink = sinkFor(pool);
    persisted(await sink.persist(exportOf()));

    const scenarios = [
      { name: 'another batch key', reason: 'changed_batch_same_sequence', at: later(60),
        left: exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60), rows: rows('4') }),
        right: exportOf({ batchKey: 'synthetic-export-002b', exportedAt: later(60), rows: rows('4') }) },
      { name: 'changed content', reason: 'changed_content_same_sequence', at: later(120),
        left: exportOf({ batchKey: 'synthetic-export-003', exportedAt: later(120), rows: rows('4') }),
        right: exportOf({ batchKey: 'synthetic-export-003', exportedAt: later(120), rows: rows('5') }) },
    ];

    let revision = 1;
    let identities = 1;
    for (const scenario of scenarios) {
      const { left, right } = scenario;
      const hold = await holdInventoryLock(ids.installation, 6);
      const passes = [sink.persist(left), sink.persist(right)];
      await waitFor(lockWaiters, '2', `both ${scenario.name} passes to queue on the inventory lock`);
      await hold.released;
      const outcomes = await Promise.all(passes);

      const accepted = outcomes.filter((outcome) => outcome.kind === 'persisted');
      const refused = outcomes.filter((outcome) => outcome.kind === 'refused');
      assert.equal(accepted.length, 1, `${scenario.name}: exactly one export is accepted`);
      assert.equal(refused.length, 1, `${scenario.name}: exactly one export is refused`);
      assert.equal(refused[0]!.kind === 'refused' ? refused[0]!.reason : '', scenario.reason);
      const receipt = persisted(accepted[0]!);
      assert.equal(receipt.duplicate, false);

      revision += 1;
      identities += 1;
      assert.equal(receipt.projectionRevision, revision);
      assert.equal(await counts(), `${identities}|${identities * 2}|2|${revision}`);
      const winner = outcomes[0]!.kind === 'persisted' ? left : right;
      assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(),
        winner.rows.find((row) => row.sourceCode === '00017')!.quantity);
      assert.equal((await sql(`SELECT batch_key FROM feed_sequence_identity WHERE sequence=${secondOf(scenario.at)}`)).trim(),
        winner.batchKey);
    }
  } finally { await pool.end(); }
});

test('feed sink: the watermark is read inside the accepting transaction, so an older pass queued behind a newer one is stale', async () => {
  const pool = await setup();
  try {
    const sink = sinkFor(pool);
    persisted(await sink.persist(exportOf()));

    const newer = exportOf({ batchKey: 'synthetic-export-003', exportedAt: later(120), rows: rows('2') });
    const older = exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60), rows: rows('5') });
    const hold = await holdInventoryLock(ids.installation, 8);
    const newerPass = sink.persist(newer);
    await waitFor(lockWaiters, '1', 'the newer pass to queue on the inventory lock');
    const olderPass = sink.persist(older);
    await waitFor(lockWaiters, '2', 'the older pass to queue behind it');
    await hold.released;

    const newerReceipt = persisted(await newerPass);
    assert.equal(newerReceipt.projectionRevision, 2);
    // Both passes cleared nothing before the lock. The older one must meet the newer
    // watermark at the sink and be named stale_export there, not reach the reducer.
    refusedWith(await olderPass, 'stale_export');
    assert.equal(await counts(), '2|4|2|2');
    assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(), '2');
  } finally { await pool.end(); }
});

test('feed sink: a held inventory lock is waited on for a finite time and refused as lock_timeout', async () => {
  const pool = await setup();
  try {
    persisted(await sinkFor(pool).persist(exportOf()));
    const impatient = sinkFor(pool, subjectA, 250);
    const hold = await holdInventoryLock(ids.installation, 3);
    const started = Date.now();
    const outcome = await impatient.persist(exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60) }));
    const waited = Date.now() - started;
    await hold.released;

    refusedWith(outcome, 'lock_timeout');
    assert(waited < 2_500, `the pass waited ${waited}ms for a 250ms lock bound`);
    assert.equal(await counts(), '1|2|2|1');
    // The connection went back to the pool clean: the same export now lands.
    assert.equal(persisted(await impatient.persist(exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60) }))).projectionRevision, 2);
  } finally { await pool.end(); }
});

test('feed sink: the projection-advanced seam runs inside the accepting transaction and its failure rolls the snapshot back', async () => {
  const pool = await setup();
  try {
    const seen: { installationId: string; organisationId: string; branchId: string; snapshotId: string;
      sequence: number; projectionRevision: number; projectionRows: number }[] = [];
    const sink = createFeedSnapshotSink({
      pool, installationSubject: subjectA, lockTimeoutMs: 15_000,
      afterProjectionAdvanced: async (client, advanced) => {
        const visible = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM inventory_projection WHERE installation_id=$1', [advanced.installationId]);
        seen.push({ ...advanced, projectionRows: visible.rows[0]!.n });
      },
    });
    const receipt = persisted(await sink.persist(exportOf()));
    assert.deepEqual(seen, [{
      installationId: ids.installation, organisationId: ids.a, branchId: ids.branchA,
      snapshotId: receipt.snapshotId, sequence: receipt.sequence, projectionRevision: 1, projectionRows: 2,
    }]);
    // A duplicate does not advance the projection and does not reach the seam.
    assert.equal(persisted(await sink.persist(exportOf())).duplicate, true);
    assert.equal(seen.length, 1);

    const failing = createFeedSnapshotSink({
      pool, installationSubject: subjectA,
      afterProjectionAdvanced: async () => { throw new Error('synthetic seam failure'); },
    });
    await assert.rejects(failing.persist(exportOf({ batchKey: 'synthetic-export-002', exportedAt: later(60), rows: rows('1') })),
      /synthetic seam failure/);
    assert.equal(await counts(), '1|2|2|1');
    assert.equal((await sql(`SELECT quantity::text FROM inventory_projection WHERE source_code='00017'`)).trim(), '8.25');
  } finally { await pool.end(); }
});

test('feed sink: a guarded worker pass persists through the sink and a second pass over the same drop is a duplicate', async () => {
  const pool = await setup();
  try {
    const decision = readFeedManifest({
      installationSubject: subjectA, batchKey: 'synthetic-export-001', exportedAt: T0,
      maxFiles: 2, maxInputBytes: 64 * 1024, maxDecompressedBytes: 256 * 1024,
      columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
      contract: { adapterId: 'synthetic-pos', revision: 1, sourceCodeNormalization: 'trim',
        unitAliases: { box: 'box', strip: 'strip' } },
      files: [{ relativePath: 'part-a.csv', partitionKey: 'part-a', format: 'delimited', compressed: false }],
    });
    assert.equal(decision.kind, 'accepted');
    const manifest = decision.kind === 'accepted' ? decision.manifest : (undefined as never);
    const root = path.resolve('/srv/pharmacart/synthetic-feed-drop');
    const data = new TextEncoder().encode('ITEM_CODE,QTY_ON_HAND,UOM\r\n00017,8.250,BOX\r\n00018,3,strip\r\n');
    const sink: FeedSnapshotSink = sinkFor(pool);
    const pass = () => runFeedPass({
      root, manifest, sink,
      directory: { list: async () => [{ name: 'part-a.csv', kind: 'file' }] },
      reader: { readContained: async (request) => ({ kind: 'accepted', absolutePath: path.join(request.root, request.relativePath), data }) },
    });

    const first = await pass();
    assert.equal(first.kind, 'completed');
    const firstDecisions = first.kind === 'completed' ? first.decisions : [];
    assert.deepEqual(firstDecisions.map((entry) => entry.kind), ['accepted']);
    const second = await pass();
    assert.deepEqual(second.kind === 'completed' ? second.decisions.map((entry) => entry.kind) : [], ['duplicate']);
    assert.equal(await counts(), '1|2|2|1');

    await setStatus(ids.installation, 'suspended');
    const denied = await pass();
    const deniedDecision = denied.kind === 'completed' ? denied.decisions[0] : undefined;
    assert.equal(deniedDecision?.kind, 'rejected');
    assert.equal(deniedDecision?.kind === 'rejected' ? `${deniedDecision.stage}:${deniedDecision.reason}` : '',
      'persistence:installation_suspended');
    assert.equal(await counts(), '1|2|2|1');
  } finally { await pool.end(); }
});

test('feed sink: the runtime role keeps feed_sequence_identity append-only', async () => {
  const pool = await resetDatabase();
  try {
    assert.equal((await sql(`SELECT has_table_privilege('pharmacart_runtime','feed_sequence_identity','SELECT')::text || '|' ||
      has_table_privilege('pharmacart_runtime','feed_sequence_identity','INSERT')::text || '|' ||
      has_table_privilege('pharmacart_runtime','feed_sequence_identity','UPDATE')::text || '|' ||
      has_table_privilege('pharmacart_runtime','feed_sequence_identity','DELETE')::text`)).trim(), 'true|true|false|false');
    assert.equal((await sql(`SELECT relrowsecurity::text || '|' || relforcerowsecurity::text FROM pg_class WHERE relname='feed_sequence_identity'`)).trim(),
      'true|true');
  } finally { await pool.end(); }
});
