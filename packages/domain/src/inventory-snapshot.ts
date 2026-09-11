import { isNonNegativeDecimalString } from '../../contracts/src/decimal.ts';

export type InventoryRow = Readonly<{ sourceCode: string; quantity: string; unit: string }>;

type EventScope = Readonly<{
  eventId: string;
  installationId: string;
  snapshotId: string;
  sequence: number;
}>;

export type InventorySnapshotEvent =
  | (EventScope & Readonly<{ kind: 'partition'; partitionId: string; rows: readonly InventoryRow[] }>)
  | (EventScope & Readonly<{ kind: 'complete'; expectedPartitionIds: readonly string[] }>);

type SnapshotProgress = Readonly<{
  installationId: string;
  snapshotId: string;
  sequence: number;
  partitions: Readonly<Record<string, readonly InventoryRow[]>>;
  expectedPartitionIds?: readonly string[];
}>;

export type InventoryProjectionRow = InventoryRow & Readonly<{
  stale: boolean;
  snapshotId: string;
  sequence: number;
}>;

export type InventorySnapshotState = Readonly<{
  eventFingerprints: Readonly<Record<string, string>>;
  snapshots: Readonly<Record<string, SnapshotProgress>>;
  projections: Readonly<Record<string, Readonly<Record<string, InventoryProjectionRow>>>>;
  latestSequence: Readonly<Record<string, number>>;
  completedSequence: Readonly<Record<string, number>>;
  projectionRevision: number;
}>;

export type ApplyInventorySnapshotResult =
  | Readonly<{ kind: 'accepted' | 'duplicate'; state: InventorySnapshotState }>
  | Readonly<{
      kind: 'rejected';
      reason: 'conflicting_event' | 'conflicting_partition' | 'conflicting_snapshot'
        | 'stale_sequence' | 'invalid_event' | 'duplicate_source_row';
      state: InventorySnapshotState;
    }>;

export function emptyInventorySnapshotState(): InventorySnapshotState {
  return {
    eventFingerprints: Object.freeze({}),
    snapshots: Object.freeze({}),
    projections: Object.freeze({}),
    latestSequence: Object.freeze({}),
    completedSequence: Object.freeze({}),
    projectionRevision: 0,
  };
}

export function applyInventorySnapshotEvent(
  state: InventorySnapshotState,
  event: InventorySnapshotEvent,
): ApplyInventorySnapshotResult {
  if (!validEvent(event)) return { kind: 'rejected', reason: 'invalid_event', state };
  const fingerprint = eventFingerprint(event);
  const eventKey = snapshotKey(event.installationId, event.eventId);
  const priorFingerprint = own(state.eventFingerprints, eventKey);
  if (priorFingerprint !== undefined) {
    return priorFingerprint === fingerprint
      ? { kind: 'duplicate', state }
      : { kind: 'rejected', reason: 'conflicting_event', state };
  }

  const key = snapshotKey(event.installationId, event.snapshotId);
  const progress = own(state.snapshots, key);
  if (progress !== undefined && progress.sequence !== event.sequence) {
    return { kind: 'rejected', reason: 'conflicting_snapshot', state };
  }
  const latest = own(state.latestSequence, event.installationId);
  const completed = own(state.completedSequence, event.installationId);
  if ((latest !== undefined && event.sequence < latest)
      || (completed !== undefined && event.sequence < completed)
      || (progress === undefined && event.sequence === latest)) {
    return { kind: 'rejected', reason: 'stale_sequence', state };
  }

  const current: SnapshotProgress = progress ?? {
    installationId: event.installationId,
    snapshotId: event.snapshotId,
    sequence: event.sequence,
    partitions: Object.freeze({}),
  };
  let nextProgress: SnapshotProgress;
  if (event.kind === 'partition') {
    if (current.expectedPartitionIds !== undefined && !current.expectedPartitionIds.includes(event.partitionId)) {
      return { kind: 'rejected', reason: 'conflicting_snapshot', state };
    }
    const priorPartition = own(current.partitions, event.partitionId);
    if (priorPartition !== undefined && rowsFingerprint(priorPartition) !== rowsFingerprint(event.rows)) {
      return { kind: 'rejected', reason: 'conflicting_partition', state };
    }
    nextProgress = priorPartition === undefined
      ? { ...current, partitions: Object.freeze({ ...current.partitions, [event.partitionId]: freezeRows(event.rows) }) }
      : current;
  } else {
    if (Object.keys(current.partitions).some((id) => !event.expectedPartitionIds.includes(id))) {
      return { kind: 'rejected', reason: 'conflicting_snapshot', state };
    }
    if (current.expectedPartitionIds !== undefined
      && stringListFingerprint(current.expectedPartitionIds) !== stringListFingerprint(event.expectedPartitionIds)) {
      return { kind: 'rejected', reason: 'conflicting_snapshot', state };
    }
    nextProgress = current.expectedPartitionIds === undefined
      ? { ...current, expectedPartitionIds: Object.freeze([...event.expectedPartitionIds].sort()) }
      : current;
  }

  const firstForNewSequence = progress === undefined;
  const nextState: InventorySnapshotState = {
    ...state,
    eventFingerprints: Object.freeze({ ...state.eventFingerprints, [eventKey]: fingerprint }),
    snapshots: Object.freeze({ ...state.snapshots, [key]: Object.freeze(nextProgress) }),
    latestSequence: firstForNewSequence
      ? Object.freeze({ ...state.latestSequence, [event.installationId]: event.sequence })
      : state.latestSequence,
    projections: firstForNewSequence
      ? markInstallationStale(state.projections, event.installationId)
      : state.projections,
  };

  if (!isComplete(nextProgress)) return { kind: 'accepted', state: Object.freeze(nextState) };
  if (completed === event.sequence) return { kind: 'accepted', state: Object.freeze(nextState) };
  const projected = projectRows(nextProgress);
  if (projected === undefined) {
    return { kind: 'rejected', reason: 'duplicate_source_row', state };
  }
  return {
    kind: 'accepted',
    state: Object.freeze({
      ...nextState,
      projections: Object.freeze({ ...nextState.projections, [event.installationId]: projected }),
      completedSequence: Object.freeze({ ...state.completedSequence, [event.installationId]: event.sequence }),
      projectionRevision: state.projectionRevision + 1,
    }),
  };
}

function validEvent(event: InventorySnapshotEvent): boolean {
  if (!nonempty(event.eventId) || !nonempty(event.installationId) || !nonempty(event.snapshotId)
      || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) return false;
  if (event.kind === 'complete') {
    return event.expectedPartitionIds.length > 0
      && event.expectedPartitionIds.every(nonempty)
      && new Set(event.expectedPartitionIds).size === event.expectedPartitionIds.length;
  }
  return nonempty(event.partitionId)
    && event.rows.every((row) => nonempty(row.sourceCode) && nonempty(row.unit)
      && isNonNegativeDecimalString(row.quantity))
    && new Set(event.rows.map((row) => row.sourceCode)).size === event.rows.length;
}

function isComplete(progress: SnapshotProgress): progress is SnapshotProgress & Readonly<{ expectedPartitionIds: readonly string[] }> {
  return progress.expectedPartitionIds !== undefined
    && progress.expectedPartitionIds.every((id) => Object.hasOwn(progress.partitions, id))
    && Object.keys(progress.partitions).every((id) => progress.expectedPartitionIds!.includes(id));
}

function projectRows(progress: SnapshotProgress): Readonly<Record<string, InventoryProjectionRow>> | undefined {
  const projected: Record<string, InventoryProjectionRow> = {};
  for (const partitionId of Object.keys(progress.partitions).sort()) {
    for (const row of progress.partitions[partitionId]!) {
      if (Object.hasOwn(projected, row.sourceCode)) return undefined;
      Object.defineProperty(projected, row.sourceCode, { enumerable: true,
        value: Object.freeze({ ...row, stale: false, snapshotId: progress.snapshotId, sequence: progress.sequence }) });
    }
  }
  return Object.freeze(projected);
}

function markInstallationStale(
  projections: InventorySnapshotState['projections'], installationId: string,
): InventorySnapshotState['projections'] {
  const existing = own(projections, installationId);
  if (existing === undefined) return projections;
  return Object.freeze({
    ...projections,
    [installationId]: Object.freeze(Object.fromEntries(
      Object.entries(existing).map(([sourceCode, row]) => [sourceCode, Object.freeze({ ...row, stale: true })]),
    )),
  });
}

function eventFingerprint(event: InventorySnapshotEvent): string {
  const scope = [event.kind, event.eventId, event.installationId, event.snapshotId, event.sequence];
  return event.kind === 'partition'
    ? JSON.stringify([...scope, event.partitionId, rowsFingerprint(event.rows)])
    : JSON.stringify([...scope, [...event.expectedPartitionIds].sort()]);
}

function freezeRows(rows: readonly InventoryRow[]): readonly InventoryRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function rowsFingerprint(rows: readonly InventoryRow[]): string {
  return JSON.stringify(rows.map(({ sourceCode, quantity, unit }) => [sourceCode, quantity, unit])
    .sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

function stringListFingerprint(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

function snapshotKey(installationId: string, snapshotId: string): string {
  return `${installationId}\u0000${snapshotId}`;
}

function nonempty(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\u0000');
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
