import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyInventorySnapshotEvent,
  emptyInventorySnapshotState,
  type InventoryProjectionRow,
  type InventorySnapshotEvent,
} from '../../domain/src/inventory-snapshot.ts';
import { readDatabaseViewRows } from '../src/database-view-transport.ts';
import { readDelimitedInventoryFile } from '../src/delimited-transport.ts';
import {
  adaptInventoryObservations,
  type InventoryAdapterContract,
  type InventoryEnvelope,
} from '../src/inventory-adapter.ts';
import { readJsonInventoryPayload } from '../src/json-transport.ts';
import type { TransportDecision } from '../src/transport-result.ts';

const contract: InventoryAdapterContract = {
  adapterId: 'synthetic-pos',
  revision: 1,
  sourceCodeNormalization: 'trim',
  unitAliases: { box: 'box', boxes: 'box', bx: 'box', strip: 'strip', tab: 'tablet', tablet: 'tablet' },
};

const envelope: InventoryEnvelope = {
  eventId: 'evt-0001',
  installationId: 'inst-branch-01',
  snapshotId: 'snap-2026-09-12',
  sequence: 7,
  partitionId: 'part-a',
};

const columns = { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' } as const;

/**
 * One logical stock position, deliberately spelled differently per transport:
 * SKU-1 is 12.5 boxes, SKU-2 is 7 boxes, SKU-3 is 0 tablets.
 */
const jsonPayload: unknown = [
  { sourceCode: 'SKU-2', quantity: '7', unit: 'box' },
  { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
  { sourceCode: 'SKU-3', quantity: '0', unit: 'tablet' },
];

const databaseRows: readonly Readonly<Record<string, unknown>>[] = [
  { ITEM_CODE: 'SKU-3', QTY_ON_HAND: 0, UOM: 'TAB', ROW_VERSION: 91 },
  { ITEM_CODE: 'SKU-2', QTY_ON_HAND: 7, UOM: 'Boxes', ROW_VERSION: 44 },
  { ITEM_CODE: 'SKU-1', QTY_ON_HAND: '12.5000', UOM: 'BX', ROW_VERSION: 12 },
];

const delimitedFile = new TextEncoder().encode(
  '\ufeffUOM,ITEM_CODE,QTY_ON_HAND,NOTE\r\n'
  + 'BX, SKU-1 ,12.500,"first, line"\r\n'
  + 'Boxes, SKU-2 ,007,plain\r\n'
  + 'TAB, SKU-3 ,0.00,plain\r\n',
);

function eventFrom(decision: TransportDecision): InventorySnapshotEvent {
  assert.equal(decision.kind, 'accepted', decision.kind === 'rejected' ? decision.reason : '');
  const observations = decision.kind === 'accepted' ? decision.observations : [];
  const adapted = adaptInventoryObservations(contract, envelope, observations);
  assert.equal(adapted.kind, 'accepted', adapted.kind === 'rejected' ? adapted.reason : '');
  return adapted.kind === 'accepted' ? adapted.event : (undefined as never);
}

function projectionFrom(event: InventorySnapshotEvent): Readonly<Record<string, InventoryProjectionRow>> {
  const partition = applyInventorySnapshotEvent(emptyInventorySnapshotState(), event);
  assert.equal(partition.kind, 'accepted');

  const completed = applyInventorySnapshotEvent(partition.state, {
    kind: 'complete',
    eventId: 'evt-0002',
    installationId: envelope.installationId,
    snapshotId: envelope.snapshotId,
    sequence: envelope.sequence,
    expectedPartitionIds: [envelope.partitionId],
  });
  assert.equal(completed.kind, 'accepted');

  const projection = completed.state.projections[envelope.installationId];
  assert.notEqual(projection, undefined);
  return projection!;
}

describe('AC-015 cross-transport equivalence', () => {
  const viaJson = eventFrom(readJsonInventoryPayload(jsonPayload));
  const viaDatabase = eventFrom(readDatabaseViewRows(columns, databaseRows));
  const viaFile = eventFrom(readDelimitedInventoryFile(columns, delimitedFile));

  it('produces one canonical event from every supported transport', () => {
    assert.deepEqual(viaDatabase, viaJson);
    assert.deepEqual(viaFile, viaJson);
  });

  it('produces one canonical projection including units, version and freshness', () => {
    const fromJson = projectionFrom(viaJson);
    const fromDatabase = projectionFrom(viaDatabase);
    const fromFile = projectionFrom(viaFile);

    assert.deepEqual(fromDatabase, fromJson);
    assert.deepEqual(fromFile, fromJson);

    assert.deepEqual(fromJson, {
      'SKU-1': {
        sourceCode: 'SKU-1',
        quantity: '12.5',
        unit: 'box',
        stale: false,
        snapshotId: 'snap-2026-09-12',
        sequence: 7,
      },
      'SKU-2': {
        sourceCode: 'SKU-2',
        quantity: '7',
        unit: 'box',
        stale: false,
        snapshotId: 'snap-2026-09-12',
        sequence: 7,
      },
      'SKU-3': {
        sourceCode: 'SKU-3',
        quantity: '0',
        unit: 'tablet',
        stale: false,
        snapshotId: 'snap-2026-09-12',
        sequence: 7,
      },
    });
  });

  it('agrees on purchase meaning rather than on row order or spelling', () => {
    const quantities = (projection: Readonly<Record<string, InventoryProjectionRow>>): string[] =>
      Object.keys(projection).sort().map((code) => `${code}=${projection[code]!.quantity}${projection[code]!.unit}`);

    assert.deepEqual(quantities(projectionFrom(viaFile)), ['SKU-1=12.5box', 'SKU-2=7box', 'SKU-3=0tablet']);
    assert.deepEqual(quantities(projectionFrom(viaDatabase)), quantities(projectionFrom(viaFile)));
  });

  it('still distinguishes genuinely different stock, so equivalence is not vacuous', () => {
    const changed = eventFrom(readJsonInventoryPayload([
      { sourceCode: 'SKU-2', quantity: '7', unit: 'box' },
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'strip' },
      { sourceCode: 'SKU-3', quantity: '0', unit: 'tablet' },
    ]));

    assert.notDeepEqual(changed, viaJson);
    assert.notDeepEqual(projectionFrom(changed), projectionFrom(viaJson));
  });
});
