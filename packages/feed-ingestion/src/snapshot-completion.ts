import { createHash } from 'node:crypto';

import type { InventorySnapshotEvent } from '../../domain/src/inventory-snapshot.ts';
import type { InventoryEnvelope } from '../../transport-adapters/src/inventory-adapter.ts';

export type CompleteSnapshotEvent = Extract<InventorySnapshotEvent, { kind: 'complete' }>;

const DIGEST_LENGTH = 32;

/**
 * A snapshot is only projected once its completion event arrives, so the
 * completion needs an identity with the same replay property the partition
 * already has. Deriving it from the envelope and the expected partitions means a
 * worker that dies between the two writes, or an operator who re-drops the same
 * export, presents the same completion again and the reducer calls it a
 * duplicate rather than completing a second snapshot.
 *
 * The prefix keeps it disjoint from `deriveSnapshotEnvelope`'s `evt-` partition
 * identities, which share the same hash inputs, so the two can never collide in
 * the inbox primary key.
 */
export function deriveCompletionEventId(
  envelope: InventoryEnvelope,
  expectedPartitionIds: readonly string[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      envelope.installationId,
      envelope.snapshotId,
      envelope.sequence,
      [...expectedPartitionIds].sort(),
    ]))
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
  return `cevt-${digest}`;
}

/**
 * A drop directory where one file is one whole export: the partition it carries
 * is the only partition the snapshot will ever have. The caller is expected to
 * accept both events in one transaction, because a snapshot left open by a
 * committed partition and an uncommitted completion holds the prior projection
 * stale with nothing on its way to replace it.
 */
export function completeSingleFileSnapshot(envelope: InventoryEnvelope): CompleteSnapshotEvent {
  const expectedPartitionIds = Object.freeze([envelope.partitionId]);
  return Object.freeze({
    kind: 'complete',
    eventId: deriveCompletionEventId(envelope, expectedPartitionIds),
    installationId: envelope.installationId,
    snapshotId: envelope.snapshotId,
    sequence: envelope.sequence,
    expectedPartitionIds,
  });
}


