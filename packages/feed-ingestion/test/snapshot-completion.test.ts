import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type InventoryRow,
} from '../../domain/src/inventory-snapshot.ts';
import { deriveSnapshotEnvelope } from '../../feed-identity/src/snapshot-envelope.ts';
import type { InventoryEnvelope } from '../../transport-adapters/src/inventory-adapter.ts';
import {
  completeSingleFileSnapshot,
  deriveCompletionEventId,
} from '../src/snapshot-completion.ts';

const rows: readonly InventoryRow[] = [
  { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
  { sourceCode: 'SKU-2', quantity: '7', unit: 'box' },
];

function envelope(overrides: Partial<InventoryEnvelope> = {}): InventoryEnvelope {
  const derivation = deriveSnapshotEnvelope({
    installationId: '50000000-0000-4000-8000-000000000001',
    batchKey: 'export-2026-09-12',
    partitionKey: 'part-a.csv',
    exportedAt: '2026-09-12T06:30:00Z',
    rows,
  }, null);
  assert.equal(derivation.kind, 'derived');
  return { ...(derivation.kind === 'derived' ? derivation.envelope : ({} as InventoryEnvelope)), ...overrides };
}

describe('deterministic completion identity for a single-file snapshot', () => {
  it('derives the same completion event id from the same envelope every time', () => {
    assert.equal(
      deriveCompletionEventId(envelope(), ['p1']),
      deriveCompletionEventId(envelope(), ['p1']),
    );
  });

  it('never collides with the partition event it completes', () => {
    const derived = envelope();
    assert.notEqual(completeSingleFileSnapshot(derived).eventId, derived.eventId);
  });

  it('ignores the order the expected partitions are listed in', () => {
    assert.equal(
      deriveCompletionEventId(envelope(), ['p1', 'p2']),
      deriveCompletionEventId(envelope(), ['p2', 'p1']),
    );
  });

  it('separates completions of different snapshots, sequences and installations', () => {
    const base = deriveCompletionEventId(envelope(), ['p1']);
    assert.notEqual(deriveCompletionEventId(envelope({ snapshotId: 'snap-other' }), ['p1']), base);
    assert.notEqual(deriveCompletionEventId(envelope({ sequence: 999 }), ['p1']), base);
    assert.notEqual(deriveCompletionEventId(envelope({ installationId: 'other' }), ['p1']), base);
    assert.notEqual(deriveCompletionEventId(envelope(), ['p2']), base);
  });

  it('completes exactly the one partition of the envelope it was built from', () => {
    const derived = envelope();
    const completion = completeSingleFileSnapshot(derived);

    assert.equal(completion.kind, 'complete');
    assert.equal(completion.installationId, derived.installationId);
    assert.equal(completion.snapshotId, derived.snapshotId);
    assert.equal(completion.sequence, derived.sequence);
    assert.deepEqual([...completion.expectedPartitionIds], [derived.partitionId]);
    assert.equal(completion.eventId, deriveCompletionEventId(derived, [derived.partitionId]));
  });
});

describe('partition and completion applied together', () => {
  it('projects the snapshot in one pass and recognises the replay of both', () => {
    const derived = envelope();
    const partition = { kind: 'partition' as const, ...derived, rows };
    const completion = completeSingleFileSnapshot(derived);

    const first = applyInventorySnapshotEvent(emptyInventorySnapshotState(), partition);
    assert.equal(first.kind, 'accepted');
    const completed = applyInventorySnapshotEvent(first.state, completion);
    assert.equal(completed.kind, 'accepted');
    assert.equal(completed.state.projectionRevision, 1);

    const replayPartition = applyInventorySnapshotEvent(completed.state, partition);
    assert.equal(replayPartition.kind, 'duplicate');
    const replayCompletion = applyInventorySnapshotEvent(replayPartition.state, completeSingleFileSnapshot(derived));
    assert.equal(replayCompletion.kind, 'duplicate');
    assert.equal(replayCompletion.state.projectionRevision, 1);
  });
});


