import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type ApplyInventorySnapshotResult,
  type InventoryRow,
  type InventorySnapshotEvent,
  type InventorySnapshotState,
} from '../../domain/src/inventory-snapshot.ts';
import { deriveSnapshotEnvelope, type EnvelopeRejectionReason } from '../../feed-identity/src/snapshot-envelope.ts';
import { completeSingleFileSnapshot } from '../../feed-ingestion/src/snapshot-completion.ts';
import type { InventoryEnvelope } from '../../transport-adapters/src/inventory-adapter.ts';
import { loadInstallation, refuseInstallation, type InstallationRefusal } from './installation.ts';
import type { RuntimeClient } from './runtime.ts';

/**
 * Transactional persistence for one guarded feed pass. The shapes below are
 * structurally identical to FeedSnapshotSubmission and FeedSnapshotReceipt in
 * apps/worker/src/feed-worker.ts; they are declared here so the database package
 * does not import from an application, and the worker entry point assigns this
 * sink to its FeedSnapshotSink interface, which is where the type checker holds
 * the two in step.
 */
export type FeedSinkSubmission = Readonly<{
  batchKey: string;
  partitionKey: string;
  exportedAt: string;
  rows: readonly InventoryRow[];
}>;

export type FeedSinkReceipt = Readonly<{
  eventId: string;
  completionEventId: string;
  snapshotId: string;
  partitionId: string;
  sequence: number;
  duplicate: boolean;
  projectionRevision: number;
}>;

export type SameSequenceRefusalReason =
  | 'changed_content_same_sequence'
  | 'changed_batch_same_sequence'
  | 'changed_partition_same_sequence';

export type InventoryReducerRejectionReason = Extract<ApplyInventorySnapshotResult, { kind: 'rejected' }>['reason'];

export type FeedSinkRefusalReason =
  | InstallationRefusal['reason']
  | EnvelopeRejectionReason
  | SameSequenceRefusalReason
  | InventoryReducerRejectionReason
  | 'lock_timeout';

export type FeedSinkOutcome =
  | Readonly<{ kind: 'persisted'; receipt: FeedSinkReceipt }>
  | Readonly<{ kind: 'refused'; reason: FeedSinkRefusalReason; detail: string }>;

/** What a landed snapshot changed, handed to the projection-advanced seam. */
export type ProjectionAdvanced = Readonly<{
  installationId: string;
  organisationId: string;
  branchId: string;
  snapshotId: string;
  sequence: number;
  projectionRevision: number;
}>;

/**
 * The seam where need reconciliation attaches once that lane is integrated. It
 * runs inside the accepting transaction, after the projection is rewritten and
 * only when the projection revision advanced, so whatever attaches sees the new
 * stock and commits or rolls back with it. Nothing attaches today: this sink
 * deliberately does not recalculate needs.
 */
export type ProjectionAdvancedSeam = (client: RuntimeClient, advanced: ProjectionAdvanced) => Promise<void>;

export type FeedSnapshotSinkOptions = Readonly<{
  pool: Pool;
  /** The paired installation's authenticated subject; trusted service configuration, never feed input. */
  installationSubject: string;
  /** Upper bound on every lock wait inside the accepting transaction. */
  lockTimeoutMs?: number;
  afterProjectionAdvanced?: ProjectionAdvancedSeam;
}>;

export type FeedSnapshotStore = Readonly<{
  /** Persists one single-file export or refuses it by name. Unexpected database failures reject. */
  persist(submission: FeedSinkSubmission): Promise<FeedSinkOutcome>;
  /** The FeedSnapshotSink contract: a refusal is thrown as FeedSinkRefusalError carrying its name as `code`. */
  ingest(submission: FeedSinkSubmission): Promise<FeedSinkReceipt>;
}>;

export type SequenceClaim = Readonly<{ batchKey: string; partitionKey: string; contentDigest: string }>;

export type SequenceClaimDecision =
  | Readonly<{ kind: 'unclaimed' }>
  | Readonly<{ kind: 'replay' }>
  | Readonly<{ kind: 'refused'; reason: SameSequenceRefusalReason }>;

export const FEED_SINK_LIMITS = Object.freeze({
  defaultLockTimeoutMs: 5_000,
  maxLockTimeoutMs: 60_000,
  maxSubjectLength: 256,
});

export class FeedSinkRefusalError extends Error {
  readonly code: FeedSinkRefusalReason;
  readonly detail: string;
  constructor(reason: FeedSinkRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'FeedSinkRefusalError';
    this.code = reason;
    this.detail = detail;
  }
}

const LOCK_NOT_AVAILABLE = '55P03';
const SUBJECT_PATTERN = /^[\x21-\x7e]+$/;

/**
 * What an already-claimed whole second means for a new submission. Migration
 * 0013 records every accepted feed against the second it claimed. An exact
 * match on batch key, partition key and content digest is a replay and proceeds
 * so the reducer reports the duplicate; everything else is refused, and the
 * refusal names what differs rather than collapsing into the existing snapshot
 * or surfacing later as a stale sequence.
 */
export function classifySequenceClaim(existing: readonly SequenceClaim[], candidate: SequenceClaim): SequenceClaimDecision {
  if (existing.length === 0) return { kind: 'unclaimed' };
  const samePartition = existing.find((claim) =>
    claim.batchKey === candidate.batchKey && claim.partitionKey === candidate.partitionKey
    && claim.contentDigest === candidate.contentDigest);
  if (samePartition !== undefined) return { kind: 'replay' };
  if (existing.some((claim) => claim.batchKey === candidate.batchKey && claim.partitionKey === candidate.partitionKey)) {
    return { kind: 'refused', reason: 'changed_content_same_sequence' };
  }
  if (existing.some((claim) => claim.batchKey === candidate.batchKey)) {
    return { kind: 'refused', reason: 'changed_partition_same_sequence' };
  }
  return { kind: 'refused', reason: 'changed_batch_same_sequence' };
}

export function createFeedSnapshotSink(options: FeedSnapshotSinkOptions): FeedSnapshotStore {
  const config = validatedConfig(options);
  const persist = (submission: FeedSinkSubmission) => persistFeedSnapshot(config, submission);
  return Object.freeze({
    persist,
    ingest: async (submission: FeedSinkSubmission) => {
      const outcome = await persist(submission);
      if (outcome.kind === 'refused') throw new FeedSinkRefusalError(outcome.reason, outcome.detail);
      return outcome.receipt;
    },
  });
}

type SinkConfig = Readonly<{
  pool: Pool;
  subject: string;
  lockTimeoutMs: number;
  seam: ProjectionAdvancedSeam | null;
}>;

function validatedConfig(options: FeedSnapshotSinkOptions): SinkConfig {
  if (options === null || typeof options !== 'object' || options.pool === null || typeof options.pool !== 'object') {
    throw new TypeError('feed sink requires a runtime pool');
  }
  const subject = options.installationSubject;
  if (typeof subject !== 'string' || subject.length > FEED_SINK_LIMITS.maxSubjectLength || !SUBJECT_PATTERN.test(subject)) {
    throw new TypeError('feed sink installationSubject must be 1 to 256 printable characters without whitespace');
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? FEED_SINK_LIMITS.defaultLockTimeoutMs;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0 || lockTimeoutMs > FEED_SINK_LIMITS.maxLockTimeoutMs) {
    throw new RangeError(`feed sink lockTimeoutMs must be a whole number from 1 to ${FEED_SINK_LIMITS.maxLockTimeoutMs}`);
  }
  const seam = options.afterProjectionAdvanced ?? null;
  if (seam !== null && typeof seam !== 'function') throw new TypeError('afterProjectionAdvanced must be a function');
  return Object.freeze({ pool: options.pool, subject, lockTimeoutMs, seam });
}

/**
 * One transaction, per installation, in this order: bound every lock wait,
 * authorise from stored lifecycle, take the per-installation inventory lock,
 * re-authorise, read the watermark, derive the envelope, consult the claimed
 * second, run the reducer in memory, then write identity, inbox, state and
 * projection. Every refusal is decided before the first write and rolls back.
 *
 * Concurrency rests on the inventory_state row lock that the API inventory path
 * already takes. Two passes for one installation serialise on it, and the second
 * reads the watermark and the claimed second only after the first committed, so
 * it sees a duplicate or a named refusal. The identity table cannot be locked
 * directly: the runtime holds SELECT and INSERT only, and row locks need UPDATE.
 */
async function persistFeedSnapshot(config: SinkConfig, submission: FeedSinkSubmission): Promise<FeedSinkOutcome> {
  const client = await config.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE pharmacart_runtime');
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${config.lockTimeoutMs}ms`]);
    const outcome = await acceptWithinTransaction(client, config, submission);
    await client.query(outcome.kind === 'persisted' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (sqlState(error) === LOCK_NOT_AVAILABLE) {
      return refused('lock_timeout', `a lock was not granted within ${config.lockTimeoutMs}ms`);
    }
    throw error;
  } finally {
    client.release();
  }
}

type Scope = Readonly<{ installationId: string; organisationId: string; branchId: string }>;

async function acceptWithinTransaction(
  client: PoolClient,
  config: SinkConfig,
  submission: FeedSinkSubmission,
): Promise<FeedSinkOutcome> {
  const authorised = await authorise(client, config.subject);
  if ('reason' in authorised) return authorised;
  const scope = authorised;

  await client.query(
    "SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)",
    [scope.organisationId, scope.branchId],
  );
  await client.query(
    'INSERT INTO inventory_state(installation_id,organisation_id,branch_id,state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [scope.installationId, scope.organisationId, scope.branchId, JSON.stringify(emptyInventorySnapshotState())],
  );
  const locked = await client.query<{ state: string }>(
    'SELECT state FROM inventory_state WHERE installation_id=$1 FOR UPDATE', [scope.installationId]);
  // A status change may have committed while this pass queued behind another.
  const recheck = await authorise(client, config.subject);
  if ('reason' in recheck) return recheck;

  const state = JSON.parse(locked.rows[0]!.state) as InventorySnapshotState;
  const watermark = await acceptedSequenceWatermark(client, state, scope.installationId);
  const derivation = deriveSnapshotEnvelope({
    installationId: scope.installationId,
    batchKey: submission.batchKey,
    partitionKey: submission.partitionKey,
    exportedAt: submission.exportedAt,
    rows: submission.rows,
  }, watermark);
  if (derivation.kind === 'rejected') {
    return refused(derivation.reason, envelopeDetail(derivation.reason, watermark));
  }
  const { envelope, contentDigest } = derivation;

  const claim = classifySequenceClaim(await claimsAt(client, scope.installationId, envelope.sequence), {
    batchKey: submission.batchKey, partitionKey: submission.partitionKey, contentDigest,
  });
  if (claim.kind === 'refused') {
    return refused(claim.reason, `sequence ${envelope.sequence} is already claimed by a different export`);
  }

  const partitionEvent: InventorySnapshotEvent = {
    kind: 'partition', eventId: envelope.eventId, installationId: scope.installationId,
    snapshotId: envelope.snapshotId, sequence: envelope.sequence, partitionId: envelope.partitionId,
    rows: submission.rows,
  };
  const completionEvent = completeSingleFileSnapshot(envelope);
  const afterPartition = applyInventorySnapshotEvent(state, partitionEvent);
  if (afterPartition.kind === 'rejected') return refused(afterPartition.reason, 'the inventory reducer refused the partition event');
  const afterCompletion = applyInventorySnapshotEvent(afterPartition.state, completionEvent);
  if (afterCompletion.kind === 'rejected') return refused(afterCompletion.reason, 'the inventory reducer refused the completion event');

  if (claim.kind === 'unclaimed') await recordClaim(client, scope, envelope, submission, contentDigest);
  const accepted = [afterPartition, afterCompletion].some((result) => result.kind === 'accepted');
  if (afterPartition.kind === 'accepted') await recordInbox(client, scope, partitionEvent);
  if (afterCompletion.kind === 'accepted') await recordInbox(client, scope, completionEvent);
  if (accepted) await writeCheckpoint(client, scope, afterCompletion.state);

  const projectionRevision = afterCompletion.state.projectionRevision;
  if (config.seam !== null && projectionRevision > state.projectionRevision) {
    await config.seam(client, Object.freeze({
      ...scope, snapshotId: envelope.snapshotId, sequence: envelope.sequence, projectionRevision,
    }));
  }

  return {
    kind: 'persisted',
    receipt: Object.freeze({
      eventId: envelope.eventId,
      completionEventId: completionEvent.eventId,
      snapshotId: envelope.snapshotId,
      partitionId: envelope.partitionId,
      sequence: envelope.sequence,
      duplicate: !accepted,
      projectionRevision,
    }),
  };
}

async function authorise(client: RuntimeClient, subject: string): Promise<Scope | Extract<FeedSinkOutcome, { kind: 'refused' }>> {
  const installation = await loadInstallation(client, subject);
  const refusal = refuseInstallation(installation, 'submit_inventory');
  if (refusal !== null || installation === null) {
    const reason = refusal?.reason ?? 'installation_unknown';
    return { kind: 'refused', reason, detail: `the installation may not submit inventory (${reason})` };
  }
  return { installationId: installation.installationId, organisationId: installation.organisationId, branchId: installation.branchId };
}

/**
 * The later of the reducer checkpoint's latest sequence, read under the lock,
 * and the highest second the identity table has recorded, read in the same
 * transaction. They agree whenever both were written by this sink; taking the
 * maximum keeps either one sufficient to refuse a stale export.
 */
async function acceptedSequenceWatermark(
  client: RuntimeClient,
  state: InventorySnapshotState,
  installationId: string,
): Promise<number | null> {
  const recorded = await client.query<{ sequence: string | null }>(
    'SELECT max(sequence)::text AS sequence FROM feed_sequence_identity WHERE installation_id=$1', [installationId]);
  const identity = recorded.rows[0]?.sequence ?? null;
  const fromIdentity = identity === null ? null : Number(identity);
  if (fromIdentity !== null && !Number.isSafeInteger(fromIdentity)) {
    throw new Error('feed_sequence_identity holds a sequence outside the safe integer range');
  }
  const fromState = Object.hasOwn(state.latestSequence, installationId) ? state.latestSequence[installationId]! : null;
  if (fromIdentity === null) return fromState;
  if (fromState === null) return fromIdentity;
  return Math.max(fromIdentity, fromState);
}

type ClaimRow = QueryResultRow & { batch_key: string; partition_key: string; content_digest: string };

async function claimsAt(client: RuntimeClient, installationId: string, sequence: number): Promise<readonly SequenceClaim[]> {
  const result = await client.query<ClaimRow>(
    `SELECT batch_key,partition_key,content_digest FROM feed_sequence_identity
      WHERE installation_id=$1 AND sequence=$2 ORDER BY batch_key,partition_key`,
    [installationId, sequence]);
  return result.rows.map((row) => ({ batchKey: row.batch_key, partitionKey: row.partition_key, contentDigest: row.content_digest }));
}

async function recordClaim(
  client: RuntimeClient,
  scope: Scope,
  envelope: InventoryEnvelope,
  submission: FeedSinkSubmission,
  contentDigest: string,
): Promise<void> {
  await client.query(
    `INSERT INTO feed_sequence_identity(installation_id,sequence,batch_key,partition_key,organisation_id,branch_id,content_digest,snapshot_id,event_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [scope.installationId, envelope.sequence, submission.batchKey, submission.partitionKey,
      scope.organisationId, scope.branchId, contentDigest, envelope.snapshotId, envelope.eventId]);
}

/** The inbox payload has the API path's shape: the event without its installation, which the row carries. */
async function recordInbox(client: RuntimeClient, scope: Scope, event: InventorySnapshotEvent): Promise<void> {
  const payload = event.kind === 'partition'
    ? { kind: event.kind, eventId: event.eventId, snapshotId: event.snapshotId, sequence: event.sequence,
        partitionId: event.partitionId, rows: event.rows }
    : { kind: event.kind, eventId: event.eventId, snapshotId: event.snapshotId, sequence: event.sequence,
        expectedPartitionIds: event.expectedPartitionIds };
  await client.query(
    "INSERT INTO inventory_inbox(installation_id,organisation_id,branch_id,event_id,payload,processing_status) VALUES($1,$2,$3,$4,$5,'processed')",
    [scope.installationId, scope.organisationId, scope.branchId, event.eventId, JSON.stringify(payload)]);
}

async function writeCheckpoint(client: RuntimeClient, scope: Scope, state: InventorySnapshotState): Promise<void> {
  await client.query('UPDATE inventory_state SET state=$2,revision=$3 WHERE installation_id=$1',
    [scope.installationId, JSON.stringify(state), state.projectionRevision]);
  await client.query('DELETE FROM inventory_projection WHERE installation_id=$1', [scope.installationId]);
  for (const row of Object.values(state.projections[scope.installationId] ?? {})) {
    await client.query(
      'INSERT INTO inventory_projection(installation_id,organisation_id,branch_id,source_code,quantity,unit,stale,snapshot_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [scope.installationId, scope.organisationId, scope.branchId, row.sourceCode, row.quantity, row.unit, row.stale, row.snapshotId, row.sequence]);
  }
}

function envelopeDetail(reason: EnvelopeRejectionReason, watermark: number | null): string {
  return reason === 'stale_export'
    ? `the export is older than the accepted sequence ${watermark}`
    : `the feed envelope could not be derived (${reason})`;
}

function refused(reason: FeedSinkRefusalReason, detail: string): Extract<FeedSinkOutcome, { kind: 'refused' }> {
  return { kind: 'refused', reason, detail };
}

function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}
