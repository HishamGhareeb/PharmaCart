import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type InventorySnapshotState,
} from '../../domain/src/inventory-snapshot.ts';
import { deriveSnapshotEnvelope } from '../../feed-identity/src/snapshot-envelope.ts';
import { completeSingleFileSnapshot } from '../../feed-ingestion/src/snapshot-completion.ts';
import {
  classifySequenceClaim,
  createFeedSnapshotSink,
  FEED_SINK_LIMITS,
  FeedSinkRefusalError,
  type FeedSinkOutcome,
  type FeedSinkSubmission,
} from '../src/feed-sink.ts';

// Policy-ordering regression for the feed persistence sink. It runs no
// database: a recording client stands in for PostgreSQL so the order of
// authorisation, the per-installation lock, the in-transaction watermark read,
// the identity claim and the writes is asserted statement by statement. The
// real behaviour, including concurrency, is covered by feed-sink.test.ts.

const subject = 'synthetic:connector:a';
const ids = {
  installation: '50000000-0000-4000-8000-000000000001',
  organisation: '10000000-0000-4000-8000-000000000001',
  branch: '20000000-0000-4000-8000-000000000001',
};
const T0 = '2026-09-12T06:30:00Z';
const sequence = Math.floor(Date.parse(T0) / 1000);

const submission: FeedSinkSubmission = {
  batchKey: 'synthetic-export-001',
  partitionKey: 'part-a',
  exportedAt: T0,
  rows: [{ sourceCode: '00017', quantity: '8.25', unit: 'box' }],
};

function derived(input: FeedSinkSubmission = submission, watermark: number | null = null) {
  const decision = deriveSnapshotEnvelope({ installationId: ids.installation, ...input }, watermark);
  assert.equal(decision.kind, 'derived');
  return decision.kind === 'derived' ? decision : (undefined as never);
}

/** The inventory state after this installation already accepted `input`. */
function stateAfter(input: FeedSinkSubmission): InventorySnapshotState {
  const { envelope } = derived(input);
  const partition = applyInventorySnapshotEvent(emptyInventorySnapshotState(),
    { kind: 'partition', ...envelope, rows: input.rows });
  assert.equal(partition.kind, 'accepted');
  const complete = applyInventorySnapshotEvent(partition.state, completeSingleFileSnapshot(envelope));
  assert.equal(complete.kind, 'accepted');
  return complete.state;
}

type StoredStatus = 'pending' | 'active' | 'suspended' | 'revoked';
type Claim = { batch_key: string; partition_key: string; content_digest: string };

function lifecycleRow(status: StoredStatus) {
  return {
    id: ids.installation, organisation_id: ids.organisation, branch_id: ids.branch, status,
    paired_at: status === 'pending' ? null : new Date('2026-01-01T00:00:00.000Z'),
    status_changed_at: new Date('2026-02-01T00:00:00.000Z'),
    status_reason: null, supersedes_installation_id: null,
  };
}

function recordingPool(options: Readonly<{
  lookups?: readonly (StoredStatus | 'missing')[];
  state?: InventorySnapshotState;
  identityWatermark?: string | null;
  claims?: readonly Claim[];
  failOn?: Readonly<{ match: string; error: Error }>;
}> = {}) {
  const lookups = options.lookups ?? ['active'];
  const statements: { text: string; values: readonly unknown[] }[] = [];
  let lookup = 0;
  let released = 0;
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      statements.push({ text, values });
      if (options.failOn !== undefined && text.includes(options.failOn.match)) throw options.failOn.error;
      if (text.includes('pharmacart_installation_lifecycle')) {
        const status = lookups[Math.min(lookup, lookups.length - 1)] ?? 'missing';
        lookup += 1;
        const rows = status === 'missing' ? [] : [lifecycleRow(status)];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ state: JSON.stringify(options.state ?? emptyInventorySnapshotState()) }], rowCount: 1 };
      }
      if (text.includes('max(sequence)')) {
        return { rows: [{ sequence: options.identityWatermark ?? null }], rowCount: 1 };
      }
      if (text.includes('FROM feed_sequence_identity')) {
        const rows = options.claims ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    statements,
    texts: () => statements.map((statement) => statement.text),
    releaseCount: () => released,
    lookupCount: () => lookup,
  };
}

const writes = /INSERT INTO feed_sequence_identity|inventory_inbox|inventory_projection|UPDATE inventory_state|inventory_alert|INTO need/;
const index = (texts: readonly string[], fragment: string) => texts.findIndex((text) => text.includes(fragment));

function refusal(outcome: FeedSinkOutcome) {
  assert.equal(outcome.kind, 'refused');
  return outcome.kind === 'refused' ? outcome.reason : '';
}

test('feed sink policy: an installation that may not submit inventory is refused by name before any lock or write', async () => {
  const expected = { pending: 'pairing_incomplete', suspended: 'installation_suspended',
    revoked: 'installation_revoked', missing: 'installation_unknown' } as const;
  for (const status of ['pending', 'suspended', 'revoked', 'missing'] as const) {
    const recorded = recordingPool({ lookups: [status] });
    const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission);
    assert.equal(refusal(outcome), expected[status]);
    const texts = recorded.texts();
    assert.deepEqual(texts.filter((text) => writes.test(text) || text.includes('INSERT INTO inventory_state')), [], `${status} reached a write`);
    assert.deepEqual(texts.filter((text) => text.includes('FOR UPDATE')), [], `${status} locked inventory state`);
    assert.equal(texts.at(-1), 'ROLLBACK');
    assert.equal(recorded.releaseCount(), 1);
  }
});

test('feed sink policy: an accepted export follows lock, recheck, watermark, claim, then writes, in one transaction', async () => {
  const recorded = recordingPool();
  const sink = createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject, lockTimeoutMs: 1234 });
  const outcome = await sink.persist(submission);
  assert.equal(outcome.kind, 'persisted');

  const texts = recorded.texts();
  const order = [
    'BEGIN',
    'SET LOCAL ROLE pharmacart_runtime',
    "set_config('lock_timeout'",
    'pharmacart_installation_lifecycle',
    "set_config('app.organisation_id'",
    'INSERT INTO inventory_state',
    'FOR UPDATE',
  ].map((fragment) => index(texts, fragment));
  assert(order.every((position, at) => position >= 0 && (at === 0 || position > order[at - 1]!)),
    `statement order was ${JSON.stringify(texts)}`);
  const locked = index(texts, 'FOR UPDATE');
  const recheck = texts.findLastIndex((text) => text.includes('pharmacart_installation_lifecycle'));
  const watermark = index(texts, 'max(sequence)');
  const claims = texts.findIndex((text) => text.includes('FROM feed_sequence_identity') && !text.includes('max(sequence)'));
  const identity = index(texts, 'INSERT INTO feed_sequence_identity');
  const inbox = index(texts, 'inventory_inbox');
  const state = index(texts, 'UPDATE inventory_state');
  const projection = index(texts, 'INSERT INTO inventory_projection');
  assert(recheck > locked, 'the lifecycle is read again after waiting for the inventory lock');
  assert(watermark > recheck, 'the watermark is read after the lock, inside the transaction');
  assert(claims > watermark, 'the sequence claim is consulted after the watermark');
  assert(identity > claims && inbox > identity && state > inbox && projection > state, 'writes follow the claim');
  assert.equal(texts.at(-1), 'COMMIT');
  assert.equal(texts.filter((text) => text === 'BEGIN').length, 1, 'one transaction');
  assert.equal(texts.filter((text) => text.includes('INSERT INTO inventory_inbox')).length, 2, 'partition and completion');
  assert.equal(recorded.lookupCount(), 2);
  assert.equal(recorded.releaseCount(), 1);

  // The wait bound is set as a transaction-local setting from validated configuration.
  assert.deepEqual(recorded.statements[index(texts, "set_config('lock_timeout'")]!.values, ['1234ms']);
  // No need recalculation is triggered and no alert is raised.
  assert.deepEqual(texts.filter((text) => /INTO need|inventory_alert|inventory_target/.test(text)), []);
  // Scope comes from the stored installation row, never from the submission.
  for (const statement of recorded.statements.filter((entry) => entry.text.includes('pharmacart_installation_lifecycle'))) {
    assert.deepEqual(statement.values, [subject]);
  }
  const identityValues = recorded.statements[identity]!.values;
  const { envelope, contentDigest } = derived();
  assert.deepEqual(identityValues, [ids.installation, sequence, 'synthetic-export-001', 'part-a',
    ids.organisation, ids.branch, contentDigest, envelope.snapshotId, envelope.eventId]);
  assert.deepEqual(recorded.statements[inbox]!.values.slice(0, 4), [ids.installation, ids.organisation, ids.branch, envelope.eventId]);

  assert.deepEqual(outcome.kind === 'persisted' ? outcome.receipt : undefined, {
    eventId: envelope.eventId,
    completionEventId: completeSingleFileSnapshot(envelope).eventId,
    snapshotId: envelope.snapshotId,
    partitionId: envelope.partitionId,
    sequence,
    duplicate: false,
    projectionRevision: 1,
  });
});

test('feed sink policy: a revocation observed after the lock stops the write', async () => {
  const recorded = recordingPool({ lookups: ['active', 'revoked'] });
  const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission);
  assert.equal(refusal(outcome), 'installation_revoked');
  const texts = recorded.texts();
  assert(texts.some((text) => text.includes('FOR UPDATE')));
  assert.deepEqual(texts.filter((text) => writes.test(text)), []);
  assert.equal(index(texts, 'max(sequence)'), -1, 'no watermark is read for a refused installation');
  assert.equal(texts.at(-1), 'ROLLBACK');
  assert.equal(recorded.releaseCount(), 1);
});

test('feed sink policy: the watermark is the later of the locked reducer state and the identity table', async () => {
  const newer = { ...submission, batchKey: 'synthetic-export-002', exportedAt: '2026-09-12T06:31:00Z' };
  // From the reducer checkpoint read under the lock.
  const fromState = recordingPool({ state: stateAfter(newer) });
  assert.equal(refusal(await createFeedSnapshotSink({ pool: fromState.pool, installationSubject: subject }).persist(submission)), 'stale_export');
  assert.deepEqual(fromState.texts().filter((text) => writes.test(text)), []);
  assert.equal(fromState.texts().at(-1), 'ROLLBACK');

  // From the append-only identity table, read in the same transaction.
  const fromIdentity = recordingPool({ identityWatermark: String(sequence + 60) });
  assert.equal(refusal(await createFeedSnapshotSink({ pool: fromIdentity.pool, installationSubject: subject }).persist(submission)), 'stale_export');
  assert.deepEqual(fromIdentity.texts().filter((text) => writes.test(text)), []);
  assert.equal(fromIdentity.texts().at(-1), 'ROLLBACK');
});

test('feed sink policy: an exact replay claims nothing new, writes nothing and reports a duplicate', async () => {
  const { contentDigest } = derived();
  const recorded = recordingPool({
    state: stateAfter(submission),
    identityWatermark: String(sequence),
    claims: [{ batch_key: submission.batchKey, partition_key: submission.partitionKey, content_digest: contentDigest }],
  });
  const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission);
  assert.equal(outcome.kind, 'persisted');
  assert.equal(outcome.kind === 'persisted' ? `${outcome.receipt.duplicate}|${outcome.receipt.projectionRevision}` : '', 'true|1');
  assert.deepEqual(recorded.texts().filter((text) => writes.test(text)), []);
  assert.equal(recorded.texts().at(-1), 'COMMIT');
});

test('feed sink policy: a claimed second refuses a changed export by name without writing', async () => {
  const claim = { batch_key: submission.batchKey, partition_key: submission.partitionKey, content_digest: 'another-digest' };
  const cases: readonly [Claim, string][] = [
    [claim, 'changed_content_same_sequence'],
    [{ ...claim, batch_key: 'synthetic-export-000', content_digest: derived().contentDigest }, 'changed_batch_same_sequence'],
    [{ ...claim, partition_key: 'part-z', content_digest: derived().contentDigest }, 'changed_partition_same_sequence'],
  ];
  for (const [existing, reason] of cases) {
    const recorded = recordingPool({ identityWatermark: String(sequence), claims: [existing] });
    const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission);
    assert.equal(refusal(outcome), reason);
    assert.deepEqual(recorded.texts().filter((text) => writes.test(text)), [], `${reason} wrote`);
    assert.equal(recorded.texts().at(-1), 'ROLLBACK');
  }
});

test('feed sink policy: a reducer rejection is refused under the reducer name and rolls back', async () => {
  const recorded = recordingPool();
  const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject })
    .persist({ ...submission, rows: [{ sourceCode: '00017', quantity: '1e3', unit: 'box' }] });
  assert.equal(refusal(outcome), 'invalid_event');
  assert.deepEqual(recorded.texts().filter((text) => writes.test(text)), []);
  assert.equal(recorded.texts().at(-1), 'ROLLBACK');
});

test('feed sink policy: an envelope rejection is refused under the envelope name', async () => {
  const empty = recordingPool();
  assert.equal(refusal(await createFeedSnapshotSink({ pool: empty.pool, installationSubject: subject })
    .persist({ ...submission, rows: [] })), 'empty_partition');
  const instant = recordingPool();
  assert.equal(refusal(await createFeedSnapshotSink({ pool: instant.pool, installationSubject: subject })
    .persist({ ...submission, exportedAt: 'yesterday' })), 'invalid_exported_at');
  for (const recorded of [empty, instant]) {
    assert.deepEqual(recorded.texts().filter((text) => writes.test(text)), []);
    assert.equal(recorded.texts().at(-1), 'ROLLBACK');
  }
});

test('feed sink policy: a lock wait that exceeds the bound is refused as lock_timeout and the connection is released', async () => {
  const timeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const recorded = recordingPool({ failOn: { match: 'FOR UPDATE', error: timeout } });
  const outcome = await createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission);
  assert.equal(refusal(outcome), 'lock_timeout');
  assert.equal(recorded.texts().at(-1), 'ROLLBACK');
  assert.equal(recorded.releaseCount(), 1);
});

test('feed sink policy: any other database failure propagates after rollback and release', async () => {
  const failure = Object.assign(new Error('synthetic unique violation'), { code: '23505' });
  const recorded = recordingPool({ failOn: { match: 'INSERT INTO feed_sequence_identity', error: failure } });
  await assert.rejects(createFeedSnapshotSink({ pool: recorded.pool, installationSubject: subject }).persist(submission),
    /synthetic unique violation/);
  assert.equal(recorded.texts().at(-1), 'ROLLBACK');
  assert.equal(recorded.releaseCount(), 1);
});

test('feed sink policy: the worker adapter throws a named refusal and returns the receipt otherwise', async () => {
  const denied = recordingPool({ lookups: ['suspended'] });
  await assert.rejects(createFeedSnapshotSink({ pool: denied.pool, installationSubject: subject }).ingest(submission),
    (error: unknown) => error instanceof FeedSinkRefusalError
      && error.code === 'installation_suspended'
      && error.message.includes('installation_suspended'));
  const accepted = recordingPool();
  const receipt = await createFeedSnapshotSink({ pool: accepted.pool, installationSubject: subject }).ingest(submission);
  assert.equal(receipt.eventId, derived().envelope.eventId);
  assert.equal(receipt.duplicate, false);
});

test('feed sink policy: the projection-advanced seam is called only when the revision advances', async () => {
  const calls: unknown[] = [];
  const seam = async (_client: unknown, advanced: unknown) => { calls.push(advanced); };
  const accepted = recordingPool();
  await createFeedSnapshotSink({ pool: accepted.pool, installationSubject: subject, afterProjectionAdvanced: seam }).persist(submission);
  const { envelope } = derived();
  assert.deepEqual(calls, [{ installationId: ids.installation, organisationId: ids.organisation, branchId: ids.branch,
    snapshotId: envelope.snapshotId, sequence, projectionRevision: 1 }]);

  const replay = recordingPool({
    state: stateAfter(submission), identityWatermark: String(sequence),
    claims: [{ batch_key: submission.batchKey, partition_key: submission.partitionKey, content_digest: derived().contentDigest }],
  });
  await createFeedSnapshotSink({ pool: replay.pool, installationSubject: subject, afterProjectionAdvanced: seam }).persist(submission);
  assert.equal(calls.length, 1);
});

test('feed sink policy: configuration is validated when the sink is created', () => {
  const pool = recordingPool().pool;
  assert.equal(FEED_SINK_LIMITS.defaultLockTimeoutMs, 5_000);
  assert.equal(FEED_SINK_LIMITS.maxLockTimeoutMs, 60_000);
  for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
    assert.throws(() => createFeedSnapshotSink({ pool, installationSubject: subject, lockTimeoutMs }), RangeError, String(lockTimeoutMs));
  }
  for (const installationSubject of ['', '   ', 'synthetic: connector', 'synthetic:\u0000connector', 'x'.repeat(257)]) {
    assert.throws(() => createFeedSnapshotSink({ pool, installationSubject }), TypeError, JSON.stringify(installationSubject));
  }
  assert.throws(() => createFeedSnapshotSink({ pool: undefined as unknown as Pool, installationSubject: subject }), TypeError);
});

test('feed sink policy: classifying a claim at one second', () => {
  const candidate = { batchKey: 'b1', partitionKey: 'p1', contentDigest: 'd1' };
  assert.deepEqual(classifySequenceClaim([], candidate), { kind: 'unclaimed' });
  assert.deepEqual(classifySequenceClaim([candidate], candidate), { kind: 'replay' });
  assert.deepEqual(classifySequenceClaim([{ ...candidate, contentDigest: 'd2' }], candidate),
    { kind: 'refused', reason: 'changed_content_same_sequence' });
  assert.deepEqual(classifySequenceClaim([{ ...candidate, batchKey: 'b0' }], candidate),
    { kind: 'refused', reason: 'changed_batch_same_sequence' });
  assert.deepEqual(classifySequenceClaim([{ ...candidate, partitionKey: 'p0' }], candidate),
    { kind: 'refused', reason: 'changed_partition_same_sequence' });
  // An exact match wins over any other claim at the same second.
  assert.deepEqual(classifySequenceClaim([{ ...candidate, batchKey: 'b0' }, candidate], candidate), { kind: 'replay' });
});
