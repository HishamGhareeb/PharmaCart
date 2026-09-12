import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type InventoryRow,
} from '../../domain/src/inventory-snapshot.ts';
import {
  deriveSnapshotEnvelope,
  type FeedPartitionSpec,
} from '../src/snapshot-envelope.ts';

const rows: readonly InventoryRow[] = [
  { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
  { sourceCode: 'SKU-2', quantity: '7', unit: 'box' },
];

function spec(overrides: Partial<FeedPartitionSpec> = {}): FeedPartitionSpec {
  return {
    installationId: 'inst-branch-01',
    batchKey: 'export-2026-09-12',
    partitionKey: 'branch-01/part-a.csv',
    exportedAt: '2026-09-12T06:30:00Z',
    rows,
    ...overrides,
  };
}

function derived(overrides: Partial<FeedPartitionSpec> = {}, watermark: number | null = null) {
  const result = deriveSnapshotEnvelope(spec(overrides), watermark);
  assert.equal(result.kind, 'derived', result.kind === 'rejected' ? result.reason : '');
  return result.kind === 'derived' ? result : (undefined as never);
}

function refusal(overrides: Partial<FeedPartitionSpec>, watermark: number | null = null): string {
  const result = deriveSnapshotEnvelope(spec(overrides), watermark);
  assert.equal(result.kind, 'rejected');
  return result.kind === 'rejected' ? result.reason : '';
}

describe('replay-safe snapshot envelope derivation', () => {
  it('derives the same identity from the same feed every time', () => {
    assert.deepEqual(derived(), derived());
  });

  it('takes the sequence from the feed, never from the local clock', () => {
    const first = derived();
    const later = derived({ exportedAt: '2026-09-12T07:30:00Z' });

    assert.equal(first.envelope.sequence, Math.floor(Date.parse('2026-09-12T06:30:00Z') / 1000));
    assert.ok(later.envelope.sequence > first.envelope.sequence);
  });

  it('digests canonical content, so row order and spelling of the file cannot split one event', () => {
    const reversed = derived({ rows: [...rows].reverse() });
    assert.equal(reversed.contentDigest, derived().contentDigest);
    assert.equal(reversed.envelope.eventId, derived().envelope.eventId);
  });

  it('gives changed stock a new event without disturbing the snapshot it belongs to', () => {
    const changed = derived({
      rows: [{ sourceCode: 'SKU-1', quantity: '11', unit: 'box' }, rows[1]!],
    });
    const original = derived();

    assert.notEqual(changed.envelope.eventId, original.envelope.eventId);
    assert.equal(changed.envelope.snapshotId, original.envelope.snapshotId);
    assert.equal(changed.envelope.partitionId, original.envelope.partitionId);
  });

  it('keeps partitions of one export inside one snapshot', () => {
    const partA = derived();
    const partB = derived({ partitionKey: 'branch-01/part-b.csv' });

    assert.equal(partB.envelope.snapshotId, partA.envelope.snapshotId);
    assert.notEqual(partB.envelope.partitionId, partA.envelope.partitionId);
    assert.notEqual(partB.envelope.eventId, partA.envelope.eventId);
  });

  it('never collides across installations or batches', () => {
    const base = derived();
    const otherInstallation = derived({ installationId: 'inst-branch-02' });
    const otherBatch = derived({ batchKey: 'export-2026-09-13' });

    assert.notEqual(otherInstallation.envelope.snapshotId, base.envelope.snapshotId);
    assert.notEqual(otherInstallation.envelope.eventId, base.envelope.eventId);
    assert.notEqual(otherBatch.envelope.snapshotId, base.envelope.snapshotId);
  });

  it('produces identifiers the inventory domain accepts', () => {
    const { envelope } = derived();
    const result = applyInventorySnapshotEvent(emptyInventorySnapshotState(), {
      kind: 'partition',
      ...envelope,
      rows,
    });
    assert.equal(result.kind, 'accepted');
  });
});

describe('re-reading a feed after a restart', () => {
  it('is recognised as a duplicate rather than counted twice', () => {
    const { envelope } = derived();
    const event = { kind: 'partition' as const, ...envelope, rows };

    const first = applyInventorySnapshotEvent(emptyInventorySnapshotState(), event);
    assert.equal(first.kind, 'accepted');

    const replay = applyInventorySnapshotEvent(first.state, { ...event });
    assert.equal(replay.kind, 'duplicate');
  });

  it('refuses an export older than what has already been accepted', () => {
    const watermark = derived().envelope.sequence;
    assert.equal(
      refusal({ exportedAt: '2026-09-12T05:00:00Z' }, watermark),
      'stale_export',
    );
  });

  it('still allows the same export to be presented again', () => {
    const watermark = derived().envelope.sequence;
    assert.equal(deriveSnapshotEnvelope(spec(), watermark).kind, 'derived');
  });
});

describe('envelope derivation refusals', () => {
  it('refuses a partition it cannot identify or time', () => {
    assert.equal(refusal({ installationId: '' }), 'invalid_identity');
    assert.equal(refusal({ batchKey: '' }), 'invalid_identity');
    assert.equal(refusal({ partitionKey: '' }), 'invalid_identity');
    assert.equal(refusal({ exportedAt: 'not-a-time' }), 'invalid_exported_at');
    assert.equal(refusal({ exportedAt: '1969-12-31T23:59:00Z' }), 'invalid_exported_at');
  });

  it('refuses an empty partition rather than recording an empty branch', () => {
    assert.equal(refusal({ rows: [] }), 'empty_partition');
  });
});
