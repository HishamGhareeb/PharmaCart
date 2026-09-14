import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import { deriveSnapshotEnvelope } from '../../feed-identity/src/snapshot-envelope.ts';
import type { InventoryAdapterContract } from '../../transport-adapters/src/inventory-adapter.ts';
import type {
  ContainedFileReader,
  ContainedFileReadRequest,
} from '../../transport-safety/src/path-boundary.ts';
import {
  ingestDelimitedFeed,
  readDelimitedFeedRows,
  type FeedRowsRequest,
  type FeedRowsResult,
} from '../src/ingest-delimited-feed.ts';

const root = path.resolve('/srv/pharmacart/feed-drop');

const contract: InventoryAdapterContract = {
  adapterId: 'synthetic-pos',
  revision: 1,
  sourceCodeNormalization: 'trim',
  unitAliases: { box: 'box', boxes: 'box', bx: 'box', strip: 'strip' },
};

const CSV = 'ITEM_CODE,QTY_ON_HAND,UOM\r\nSKU-2,7,strip\r\nSKU-1,12.500,BOX\r\n';

function request(overrides: Partial<FeedRowsRequest> = {}): FeedRowsRequest {
  return {
    root,
    relativePath: 'branch-01/2026-09-12.csv',
    compressed: false,
    maxInputBytes: 1024 * 1024,
    columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
    contract,
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
        assert.equal(input.maxBytes, request().maxInputBytes, 'the reader is given the trusted byte ceiling');
        return { kind: 'accepted', absolutePath: path.join(input.root, input.relativePath), data: bytes };
      },
    },
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function rejection(result: FeedRowsResult): Readonly<{ stage: string; reason: string }> {
  assert.equal(result.kind, 'rejected', result.kind);
  return result.kind === 'rejected' ? { stage: result.stage, reason: result.reason } : { stage: '', reason: '' };
}

describe('reading a dropped file into rows before any identity exists', () => {
  it('returns canonical rows without demanding an envelope it cannot yet know', async () => {
    const source = reader(bytes(CSV));
    const result = await readDelimitedFeedRows(request(), source.read);

    assert.equal(result.kind, 'accepted', result.kind === 'rejected' ? result.reason : '');
    assert.deepEqual(source.opened, [path.join(root, 'branch-01', '2026-09-12.csv')]);
    assert.deepEqual(result.kind === 'accepted' ? [...result.rows] : [], [
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
      { sourceCode: 'SKU-2', quantity: '7', unit: 'strip' },
    ]);
    assert.equal(result.kind === 'accepted' ? result.observationCount : 0, 2);
  });

  it('produces rows an envelope can then be derived from', async () => {
    const result = await readDelimitedFeedRows(request(), reader(bytes(CSV)).read);
    assert.equal(result.kind, 'accepted');
    const derivation = deriveSnapshotEnvelope({
      installationId: 'inst-branch-01',
      batchKey: 'export-2026-09-12',
      partitionKey: '2026-09-12.csv',
      exportedAt: '2026-09-12T06:30:00Z',
      rows: result.kind === 'accepted' ? result.rows : [],
    }, null);
    assert.equal(derivation.kind, 'derived');
  });

  it('agrees exactly with the enveloped pipeline it shares its guards with', async () => {
    const envelope = {
      eventId: 'evt-1', installationId: 'inst-branch-01',
      snapshotId: 'snap-1', sequence: 7, partitionId: 'part-a',
    };
    const enveloped = await ingestDelimitedFeed({ ...request(), envelope }, reader(bytes(CSV)).read);
    const rowsOnly = await readDelimitedFeedRows(request(), reader(bytes(CSV)).read);

    assert.equal(enveloped.kind, 'accepted');
    assert.equal(rowsOnly.kind, 'accepted');
    const event = enveloped.kind === 'accepted' ? enveloped.event : undefined;
    assert.deepEqual(
      event?.kind === 'partition' ? [...event.rows] : [],
      rowsOnly.kind === 'accepted' ? [...rowsOnly.rows] : [],
    );
  });

  it('unwraps a compressed drop inside the declared budget', async () => {
    const source = reader(new Uint8Array(zlib.gzipSync(Buffer.from(CSV, 'utf8'))));
    const result = await readDelimitedFeedRows(request({ compressed: true }), source.read);
    assert.equal(result.kind, 'accepted', result.kind === 'rejected' ? result.reason : '');
  });
});

describe('the row reader refuses at the same stage the enveloped pipeline does', () => {
  it('never opens a file whose path escapes the drop root', async () => {
    const source = reader(bytes(CSV));
    const result = await readDelimitedFeedRows(request({ relativePath: '../../infra/.env' }), source.read);
    assert.deepEqual(rejection(result), { stage: 'path', reason: 'relative_segment' });
    assert.deepEqual(source.opened, []);
  });

  it('refuses a symlink the reader resolved outside the root', async () => {
    const result = await readDelimitedFeedRows(request(), {
      readContained: async () => ({ kind: 'rejected', reason: 'escapes_root', detail: 'link.csv' }),
    });
    assert.deepEqual(rejection(result), { stage: 'read', reason: 'escapes_root' });
  });

  it('refuses a byte ceiling it was never given', async () => {
    assert.deepEqual(
      rejection(await readDelimitedFeedRows(request({ maxInputBytes: 0 }), reader(bytes(CSV)).read)),
      { stage: 'read', reason: 'invalid_byte_limit' },
    );
  });

  it('refuses an oversized file and a decompression bomb before the parser', async () => {
    const oversized = await readDelimitedFeedRows(
      { ...request({ maxInputBytes: 8 }) },
      { readContained: async () => ({ kind: 'accepted', absolutePath: 'x', data: bytes(CSV) }) },
    );
    assert.deepEqual(rejection(oversized), { stage: 'read', reason: 'input_too_large' });

    const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41)));
    const inflated = await readDelimitedFeedRows(
      request({ compressed: true, maxDecompressedBytes: 64 * 1024 }),
      reader(bomb).read,
    );
    assert.deepEqual(rejection(inflated), { stage: 'decompression', reason: 'output_too_large' });
  });

  it('refuses malformed and hostile rows before any identity is derived', async () => {
    const formula = 'ITEM_CODE,QTY_ON_HAND,UOM\n"=cmd|\' /c calc\'!A0",1,box\n';
    assert.deepEqual(rejection(await readDelimitedFeedRows(request(), reader(bytes(formula)).read)),
      { stage: 'parse', reason: 'unsafe_cell' });

    const ragged = 'ITEM_CODE,QTY_ON_HAND,UOM\nSKU-1,1\n';
    assert.deepEqual(rejection(await readDelimitedFeedRows(request(), reader(bytes(ragged)).read)),
      { stage: 'parse', reason: 'ragged_row' });

    const spoofed = 'ITEM_CODE,QTY_ON_HAND,UOM\nSKU‮-1,3,box\n';
    assert.deepEqual(rejection(await readDelimitedFeedRows(request(), reader(bytes(spoofed)).read)),
      { stage: 'adapt', reason: 'unsafe_identifier' });

    const unknownUnit = 'ITEM_CODE,QTY_ON_HAND,UOM\nSKU-1,3,carton\n';
    assert.deepEqual(rejection(await readDelimitedFeedRows(request(), reader(bytes(unknownUnit)).read)),
      { stage: 'adapt', reason: 'unknown_unit' });

    const empty = 'ITEM_CODE,QTY_ON_HAND,UOM\n';
    assert.deepEqual(rejection(await readDelimitedFeedRows(request(), reader(bytes(empty)).read)),
      { stage: 'parse', reason: 'no_data_rows' });
  });
});


