import { createHash } from 'node:crypto';

import type { InventoryRow } from '../../domain/src/inventory-snapshot.ts';
import type { InventoryEnvelope } from '../../transport-adapters/src/inventory-adapter.ts';

export type FeedPartitionSpec = Readonly<{
  installationId: string;
  batchKey: string;
  partitionKey: string;
  exportedAt: string;
  rows: readonly InventoryRow[];
}>;

export type EnvelopeRejectionReason =
  | 'invalid_identity'
  | 'invalid_exported_at'
  | 'stale_export'
  | 'empty_partition';

export type EnvelopeDerivation =
  | Readonly<{ kind: 'derived'; envelope: InventoryEnvelope; contentDigest: string }>
  | Readonly<{ kind: 'rejected'; reason: EnvelopeRejectionReason }>;

const DIGEST_LENGTH = 32;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Every identifier here is a function of the feed and nothing else. Reading the
 * same export again, after a crash or a watcher restart, produces byte-identical
 * identifiers, so the inventory reducer recognises it as a duplicate instead of
 * counting the stock twice. Any use of the local clock would break that, which
 * is why the sequence comes from the export's own timestamp.
 */
export function deriveSnapshotEnvelope(
  spec: FeedPartitionSpec,
  acceptedSequence: number | null,
): EnvelopeDerivation {
  if (!identifier(spec.installationId) || !identifier(spec.batchKey) || !identifier(spec.partitionKey)) {
    return { kind: 'rejected', reason: 'invalid_identity' };
  }

  const exportedAt = Date.parse(spec.exportedAt);
  if (Number.isNaN(exportedAt) || exportedAt <= 0) {
    return { kind: 'rejected', reason: 'invalid_exported_at' };
  }

  const sequence = Math.floor(exportedAt / MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    return { kind: 'rejected', reason: 'invalid_exported_at' };
  }
  if (acceptedSequence !== null && sequence < acceptedSequence) {
    return { kind: 'rejected', reason: 'stale_export' };
  }

  if (spec.rows.length === 0) {
    return { kind: 'rejected', reason: 'empty_partition' };
  }

  const contentDigest = digest(canonicalRows(spec.rows));
  const snapshotId = `snap-${digest([spec.installationId, spec.batchKey, sequence])}`;
  const partitionId = `part-${digest([spec.partitionKey])}`;
  const eventId = `evt-${digest([spec.installationId, snapshotId, partitionId, sequence, contentDigest])}`;

  return {
    kind: 'derived',
    contentDigest,
    envelope: Object.freeze({
      eventId,
      installationId: spec.installationId,
      snapshotId,
      sequence,
      partitionId,
    }),
  };
}

function canonicalRows(rows: readonly InventoryRow[]): readonly (readonly [string, string, string])[] {
  return rows
    .map((row) => [row.sourceCode, row.quantity, row.unit] as const)
    .sort((left, right) => (left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, DIGEST_LENGTH);
}

function identifier(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.includes('\u0000');
}
