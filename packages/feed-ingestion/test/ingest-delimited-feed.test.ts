import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import { applyInventorySnapshotEvent, emptyInventorySnapshotState } from '../../domain/src/inventory-snapshot.ts';
import type { InventoryAdapterContract, InventoryEnvelope } from '../../transport-adapters/src/inventory-adapter.ts';
import {
  INGESTION_STAGES,
  ingestDelimitedFeed,
  type FeedIngestionRequest,
  type FeedIngestionResult,
} from '../src/ingest-delimited-feed.ts';
import type {
  ContainedFileReader,
  ContainedFileReadRequest,
} from '../../transport-safety/src/path-boundary.ts';

const root = path.resolve('/srv/pharmacart/feed-drop');

const contract: InventoryAdapterContract = {
  adapterId: 'synthetic-pos',
  revision: 1,
  sourceCodeNormalization: 'trim',
  unitAliases: { box: 'box', boxes: 'box', bx: 'box', strip: 'strip' },
};

const envelope: InventoryEnvelope = {
  eventId: 'evt-0001',
  installationId: 'inst-branch-01',
  snapshotId: 'snap-2026-09-12',
  sequence: 7,
  partitionId: 'part-a',
};

const CSV = 'ITEM_CODE,QTY_ON_HAND,UOM\r\nSKU-1,12.500,BOX\r\nSKU-2,7,strip\r\n';

function request(overrides: Partial<FeedIngestionRequest> = {}): FeedIngestionRequest {
  return {
    root,
    relativePath: 'branch-01/2026-09-12.csv',
    compressed: false,
    maxInputBytes: 1024 * 1024,
    columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
    contract,
    envelope,
    ...overrides,
  };
}

function reader(bytes: Uint8Array) {
  const opened: string[] = [];
  return {
    opened,
    read: {
      readContained: async (
        input: ContainedFileReadRequest,
      ): Promise<Awaited<ReturnType<ContainedFileReader['readContained']>>> => {
        opened.push(path.join(input.root, input.relativePath));
        return { kind: 'accepted', absolutePath: path.join(input.root, input.relativePath), data: bytes };
      },
    },
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function rejection(result: FeedIngestionResult): Readonly<{ stage: string; reason: string }> {
  assert.equal(result.kind, 'rejected', result.kind);
  return result.kind === 'rejected'
    ? { stage: result.stage, reason: result.reason }
    : { stage: '', reason: '' };
}

describe('delimited feed ingestion', () => {
  it('carries a dropped file all the way to an event the domain accepts', async () => {
    const source = reader(bytes(CSV));
    const result = await ingestDelimitedFeed(request(), source.read);

    assert.equal(result.kind, 'accepted', result.kind === 'rejected' ? result.reason : '');
    assert.deepEqual(source.opened, [path.join(root, 'branch-01', '2026-09-12.csv')]);

    const event = result.kind === 'accepted' ? result.event : undefined;
    assert.equal(event?.kind === 'partition' ? event.rows.length : 0, 2);
    assert.equal(
      applyInventorySnapshotEvent(emptyInventorySnapshotState(), event!).kind,
      'accepted',
    );
  });

  it('unwraps a compressed drop within its budget', async () => {
    const source = reader(new Uint8Array(zlib.gzipSync(Buffer.from(CSV, 'utf8'))));
    const result = await ingestDelimitedFeed(request({ compressed: true }), source.read);
    assert.equal(result.kind, 'accepted', result.kind === 'rejected' ? result.reason : '');
  });

  it('declares the order its guards run in', () => {
    assert.deepEqual([...INGESTION_STAGES], ['path', 'read', 'decompression', 'parse', 'adapt']);
  });
});

describe('ingestion refuses at the earliest stage that can see the problem', () => {
  it('never opens a file whose path escapes the drop root', async () => {
    const source = reader(bytes(CSV));
    const result = await ingestDelimitedFeed(
      request({ relativePath: '../../infra/.env' }),
      source.read,
    );

    assert.deepEqual(rejection(result), { stage: 'path', reason: 'relative_segment' });
    assert.deepEqual(source.opened, []);
  });

  it('surfaces a failed read as its own stage rather than an empty feed', async () => {
    const result = await ingestDelimitedFeed(request(), {
      readContained: async () => ({ kind: 'rejected', reason: 'read_failed', detail: 'EACCES' }),
    });
    assert.deepEqual(rejection(result), { stage: 'read', reason: 'read_failed' });
  });

  it('turns an unexpected reader exception into the stable read refusal', async () => {
    const result = await ingestDelimitedFeed(request(), {
      readContained: async () => {
        throw new Error('synthetic reader failure');
      },
    });
    assert.deepEqual(rejection(result), { stage: 'read', reason: 'read_failed' });
  });

  it('rejects a reader result that exceeds the declared input budget', async () => {
    const result = await ingestDelimitedFeed(
      request({ maxInputBytes: 8 }),
      reader(bytes(CSV)).read,
    );
    assert.deepEqual(rejection(result), { stage: 'read', reason: 'input_too_large' });
  });

  it('refuses a decompression bomb before anything tries to parse it', async () => {
    const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41)));
    const result = await ingestDelimitedFeed(
      request({ compressed: true, maxDecompressedBytes: 64 * 1024 }),
      reader(bomb).read,
    );
    assert.deepEqual(rejection(result), { stage: 'decompression', reason: 'output_too_large' });
  });

  it('refuses a formula payload at the parse edge', async () => {
    const hostile = 'ITEM_CODE,QTY_ON_HAND,UOM\n"=cmd|\' /c calc\'!A0",1,box\n';
    const result = await ingestDelimitedFeed(request(), reader(bytes(hostile)).read);
    assert.deepEqual(rejection(result), { stage: 'parse', reason: 'unsafe_cell' });
  });

  it('refuses a unit the contract never declared at the adapter', async () => {
    const unknown = 'ITEM_CODE,QTY_ON_HAND,UOM\nSKU-1,3,carton\n';
    const result = await ingestDelimitedFeed(request(), reader(bytes(unknown)).read);
    assert.deepEqual(rejection(result), { stage: 'adapt', reason: 'unknown_unit' });
  });

  it('refuses a source code that would read differently than it is stored', async () => {
    const spoofed = 'ITEM_CODE,QTY_ON_HAND,UOM\nSKU\u202e-1,3,box\n';
    const result = await ingestDelimitedFeed(request(), reader(bytes(spoofed)).read);
    assert.deepEqual(rejection(result), { stage: 'adapt', reason: 'unsafe_identifier' });
  });
});
