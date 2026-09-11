import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type InventorySnapshotEvent,
} from '../src/inventory-snapshot.ts';

const priorEvents = [
  {
    kind: 'partition', eventId: 'e-old-p1', installationId: 'install-a', snapshotId: 'old',
    sequence: 1, partitionId: 'p1', rows: [{ sourceCode: 'A', quantity: '5', unit: 'box' }],
  },
  {
    kind: 'complete', eventId: 'e-old-done', installationId: 'install-a', snapshotId: 'old',
    sequence: 1, expectedPartitionIds: ['p1'],
  },
] as const satisfies readonly InventorySnapshotEvent[];

function applyAll(events: readonly InventorySnapshotEvent[]) {
  let state = emptyInventorySnapshotState();
  for (const event of events) {
    const result = applyInventorySnapshotEvent(state, event);
    assert.equal(result.kind, 'accepted');
    state = result.state;
  }
  return state;
}

describe('multipart inventory snapshots', () => {
  it('never lets an old in-progress snapshot replace a newer completed one', () => {
    const state = applyAll([
      priorEvents[0]!,
      { ...priorEvents[0]!, snapshotId: 'new', sequence: 2, eventId: 'new-part', rows: [{ sourceCode: 'A', quantity: '9', unit: 'box' }] },
      { ...priorEvents[1]!, snapshotId: 'new', sequence: 2, eventId: 'new-complete' },
    ]);
    const result = applyInventorySnapshotEvent(state, priorEvents[1]!);
    assert.equal(result.kind, 'rejected');
    assert.strictEqual(result.state, state);
    assert.equal(result.state.projections['install-a']!['A']!.quantity, '9');
  });

  it('scopes event identities by installation', () => {
    const state = applyAll([priorEvents[0]!]);
    const result = applyInventorySnapshotEvent(state, { ...priorEvents[0]!, installationId: 'install-b' });
    assert.equal(result.kind, 'accepted');
  });

  it('does not republish a completed snapshot when equivalent content arrives under a different event ID', () => {
    const state = applyAll(priorEvents);
    const result = applyInventorySnapshotEvent(state, { ...priorEvents[1]!, eventId: 'second-marker' });
    assert.equal(result.state.projectionRevision, 1);
  });

  it('treats object-key order as irrelevant when detecting event replay', () => {
    const event = priorEvents[0]!;
    assert.equal(event.kind, 'partition');
    const state = applyAll([event]);
    const result = applyInventorySnapshotEvent(state, {
      sequence: 1, rows: [{ unit: 'box', quantity: '5', sourceCode: 'A' }],
      partitionId: 'p1', snapshotId: 'old', installationId: 'install-a', eventId: 'e-old-p1', kind: 'partition',
    });
    assert.equal(result.kind, 'duplicate');
  });

  it('supports opaque source and installation IDs that match object prototype names', () => {
    const state = applyAll([
      { ...priorEvents[0]!, installationId: '__proto__', rows: [{ sourceCode: 'constructor', quantity: '1', unit: 'box' }] },
      { ...priorEvents[1]!, installationId: '__proto__' },
    ]);
    assert.equal(state.projections['__proto__']!['constructor']!.quantity, '1');
  });
  it('deduplicates an identical stable event without another projection update', () => {
    const state = applyAll(priorEvents);
    const replay = applyInventorySnapshotEvent(state, priorEvents[1]!);

    assert.equal(replay.kind, 'duplicate');
    assert.strictEqual(replay.state, state);
    assert.equal(replay.state.projectionRevision, 1);
  });

  it('rejects a reused event identity with conflicting content', () => {
    const state = applyAll(priorEvents);
    const result = applyInventorySnapshotEvent(state, {
      kind: 'complete', eventId: 'e-old-done', installationId: 'install-a', snapshotId: 'old',
      sequence: 1, expectedPartitionIds: ['p1', 'p2'],
    });

    assert.deepEqual(result, { kind: 'rejected', reason: 'conflicting_event', state });
  });

  it('tracks partitions and the completion marker, retaining missing previous rows as stale until all parts arrive', () => {
    let state = applyAll(priorEvents);
    state = applyAllFrom(state, [
      {
        kind: 'partition', eventId: 'e-new-p1', installationId: 'install-a', snapshotId: 'new',
        sequence: 2, partitionId: 'p1', rows: [{ sourceCode: 'B', quantity: '8', unit: 'box' }],
      },
      {
        kind: 'complete', eventId: 'e-new-done', installationId: 'install-a', snapshotId: 'new',
        sequence: 2, expectedPartitionIds: ['p1', 'p2'],
      },
    ]);

    assert.deepEqual(state.projections['install-a'], {
      A: { sourceCode: 'A', quantity: '5', unit: 'box', stale: true, snapshotId: 'old', sequence: 1 },
    });
    assert.equal(state.projectionRevision, 1);

    state = applyAllFrom(state, [{
      kind: 'partition', eventId: 'e-new-p2', installationId: 'install-a', snapshotId: 'new',
      sequence: 2, partitionId: 'p2', rows: [{ sourceCode: 'C', quantity: '2', unit: 'box' }],
    }]);
    assert.deepEqual(Object.keys(state.projections['install-a']!).sort(), ['B', 'C']);
    assert.equal(state.projectionRevision, 2);
  });

  it('rejects conflicting duplicate partitions even when event IDs differ', () => {
    const first: InventorySnapshotEvent = {
      kind: 'partition', eventId: 'e1', installationId: 'install-a', snapshotId: 'new', sequence: 2,
      partitionId: 'p1', rows: [{ sourceCode: 'A', quantity: '1', unit: 'box' }],
    };
    const state = applyAll([first]);
    const result = applyInventorySnapshotEvent(state, {
      ...first, eventId: 'e2', rows: [{ sourceCode: 'A', quantity: '2', unit: 'box' }],
    });
    assert.equal(result.kind, 'rejected');
    assert.equal(result.reason, 'conflicting_partition');
  });

  it('scopes snapshot identity by installation', () => {
    const event = priorEvents[0]!;
    const state = applyAll([event, { ...event, eventId: 'e-install-b', installationId: 'install-b' }]);
    assert.deepEqual(Object.keys(state.snapshots).sort(), ['install-a\u0000old', 'install-b\u0000old']);
  });

  it('rejects stale sequences and prevents an older snapshot from overwriting a completed projection', () => {
    const state = applyAll(priorEvents);
    const result = applyInventorySnapshotEvent(state, {
      kind: 'partition', eventId: 'late', installationId: 'install-a', snapshotId: 'late',
      sequence: 1, partitionId: 'p1', rows: [{ sourceCode: 'A', quantity: '99', unit: 'box' }],
    });
    assert.deepEqual(result, { kind: 'rejected', reason: 'stale_sequence', state });
  });

  it('rejects invalid quantities, duplicate source rows, and malformed completion lists', () => {
    const invalidEvents: readonly InventorySnapshotEvent[] = [
      {
        kind: 'partition', eventId: 'bad-quantity', installationId: 'i', snapshotId: 's', sequence: 1,
        partitionId: 'p', rows: [{ sourceCode: 'A', quantity: '1.0', unit: 'box' }],
      },
      {
        kind: 'partition', eventId: 'duplicate-row', installationId: 'i', snapshotId: 's', sequence: 1,
        partitionId: 'p', rows: [
          { sourceCode: 'A', quantity: '1', unit: 'box' },
          { sourceCode: 'A', quantity: '2', unit: 'box' },
        ],
      },
      {
        kind: 'complete', eventId: 'bad-marker', installationId: 'i', snapshotId: 's', sequence: 1,
        expectedPartitionIds: ['p', 'p'],
      },
    ];

    for (const event of invalidEvents) {
      assert.equal(applyInventorySnapshotEvent(emptyInventorySnapshotState(), event).kind, 'rejected');
    }
  });
});

function applyAllFrom(state: ReturnType<typeof emptyInventorySnapshotState>, events: readonly InventorySnapshotEvent[]) {
  let current = state;
  for (const event of events) {
    const result = applyInventorySnapshotEvent(current, event);
    assert.equal(result.kind, 'accepted');
    current = result.state;
  }
  return current;
}
