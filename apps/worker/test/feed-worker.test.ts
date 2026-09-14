import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import type { InventoryRow } from '../../../packages/domain/src/inventory-snapshot.ts';
import { readFeedManifest, type FeedManifest } from '../../../packages/feed-ingestion/src/feed-manifest.ts';
import type {
  ContainedFileReadRequest,
  ContainedFileReadDecision,
} from '../../../packages/transport-safety/src/path-boundary.ts';
import {
  runFeedPass,
  type FeedDirectoryEntry,
  type FeedFileDecision,
  type FeedPassResult,
  type FeedSnapshotReceipt,
  type FeedSnapshotSubmission,
} from '../src/feed-worker.ts';

// The worker is exercised with injected persistence, an injected directory
// listing and an injected contained reader, so one bounded pass can be pinned
// without a database, a filesystem or a clock.

const root = path.resolve('/srv/pharmacart/feed-drop');
const CSV = 'ITEM_CODE,QTY_ON_HAND,UOM\r\nSKU-1,12.500,BOX\r\nSKU-2,7,strip\r\n';

function manifest(overrides: Record<string, unknown> = {}): FeedManifest {
  const decision = readFeedManifest({
    installationSubject: 'synthetic:connector:a',
    batchKey: 'export-2026-09-12',
    exportedAt: '2026-09-12T06:30:00Z',
    maxFiles: 4,
    maxInputBytes: 1024 * 1024,
    maxDecompressedBytes: 8 * 1024 * 1024,
    columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
    contract: {
      adapterId: 'synthetic-pos', revision: 1, sourceCodeNormalization: 'trim',
      unitAliases: { box: 'box', bx: 'box', strip: 'strip' },
    },
    files: [{ relativePath: 'part-a.csv', partitionKey: 'part-a', format: 'delimited', compressed: false }],
    ...overrides,
  });
  assert.equal(decision.kind, 'accepted', decision.kind === 'rejected' ? decision.reason : '');
  return decision.kind === 'accepted' ? decision.manifest : (undefined as never);
}

function directory(entries: readonly (string | FeedDirectoryEntry)[]) {
  const listed: string[] = [];
  return {
    listed,
    lister: {
      list: async (target: string): Promise<readonly FeedDirectoryEntry[]> => {
        listed.push(target);
        return entries.map((entry) => (typeof entry === 'string' ? { name: entry, kind: 'file' as const } : entry));
      },
    },
  };
}

function reader(contents: Readonly<Record<string, Uint8Array>>) {
  const opened: { relativePath: string; maxBytes: number }[] = [];
  return {
    opened,
    read: {
      readContained: async (input: ContainedFileReadRequest): Promise<ContainedFileReadDecision> => {
        opened.push({ relativePath: input.relativePath, maxBytes: input.maxBytes });
        const data = contents[input.relativePath];
        if (data === undefined) return { kind: 'rejected', reason: 'read_failed', detail: input.relativePath };
        return { kind: 'accepted', absolutePath: path.join(input.root, input.relativePath), data };
      },
    },
  };
}

function sink(behaviour: (submission: FeedSnapshotSubmission, call: number) => FeedSnapshotReceipt | Error = receipt) {
  const submissions: FeedSnapshotSubmission[] = [];
  return {
    submissions,
    ingest: {
      ingest: async (submission: FeedSnapshotSubmission): Promise<FeedSnapshotReceipt> => {
        submissions.push(submission);
        const outcome = behaviour(submission, submissions.length - 1);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  };
}

function receipt(submission: FeedSnapshotSubmission, call: number): FeedSnapshotReceipt {
  return {
    eventId: `evt-${submission.partitionKey}`,
    completionEventId: `cevt-${submission.partitionKey}`,
    snapshotId: 'snap-1',
    partitionId: `part-${submission.partitionKey}`,
    sequence: 1_757_658_600,
    duplicate: false,
    projectionRevision: call + 1,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decisions(result: FeedPassResult): readonly FeedFileDecision[] {
  assert.equal(result.kind, 'completed', result.kind === 'refused' ? `${result.reason}: ${result.detail}` : '');
  return result.kind === 'completed' ? result.decisions : [];
}

function refused(result: FeedPassResult): string {
  assert.equal(result.kind, 'refused', result.kind);
  return result.kind === 'refused' ? result.reason : '';
}

function rejectionOf(decision: FeedFileDecision): Readonly<{ stage: string; reason: string }> {
  assert.equal(decision.kind, 'rejected', decision.kind);
  return decision.kind === 'rejected' ? { stage: decision.stage, reason: decision.reason } : { stage: '', reason: '' };
}

describe('one bounded pass over a service-owned drop root', () => {
  it('carries a manifest-declared file into persistence and reports the decision', async () => {
    const listing = directory(['part-a.csv']);
    const files = reader({ 'part-a.csv': bytes(CSV) });
    const persistence = sink();

    const result = await runFeedPass({
      root, manifest: manifest(), reader: files.read, directory: listing.lister, sink: persistence.ingest,
    });

    assert.deepEqual(listing.listed, [root]);
    assert.deepEqual(files.opened, [{ relativePath: 'part-a.csv', maxBytes: 1024 * 1024 }]);
    assert.deepEqual(persistence.submissions, [{
      batchKey: 'export-2026-09-12',
      partitionKey: 'part-a',
      exportedAt: '2026-09-12T06:30:00Z',
      rows: [
        { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
        { sourceCode: 'SKU-2', quantity: '7', unit: 'strip' },
      ] satisfies InventoryRow[],
    }]);

    const [decision] = decisions(result);
    assert.equal(decision?.kind, 'accepted');
    assert.equal(decision?.kind === 'accepted' ? decision.rowCount : 0, 2);
    assert.equal(decision?.kind === 'accepted' ? decision.receipt.eventId : '', 'evt-part-a');
  });

  it('takes identity from the manifest and never from the local filesystem', async () => {
    const persistence = sink();
    await runFeedPass({
      root,
      manifest: manifest({ exportedAt: '2020-01-02T03:04:05Z', batchKey: 'other-batch' }),
      reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory(['part-a.csv']).lister,
      sink: persistence.ingest,
    });
    assert.equal(persistence.submissions[0]?.exportedAt, '2020-01-02T03:04:05Z');
    assert.equal(persistence.submissions[0]?.batchKey, 'other-batch');
  });

  it('reports every enumerated entry exactly once, in a stable order', async () => {
    const listing = directory(['part-b.csv', 'part-a.csv']);
    const result = await runFeedPass({
      root,
      manifest: manifest({
        maxFiles: 4,
      }),
      reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: listing.lister,
      sink: sink().ingest,
    });
    assert.deepEqual(decisions(result).map((decision) => decision.relativePath), ['part-a.csv', 'part-b.csv']);
  });

  it('is a single pass: it lists the root once and never deletes a source file', async () => {
    const listing = directory(['part-a.csv']);
    const options = {
      root, manifest: manifest(), reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: listing.lister, sink: sink().ingest,
    };
    await runFeedPass(options);
    assert.equal(listing.listed.length, 1);
    assert.equal(Object.hasOwn(options.reader, 'unlink'), false);
    assert.equal(Object.hasOwn(options.reader, 'remove'), false);
  });
});

describe('the pass refuses before it touches persistence', () => {
  it('refuses a root holding more entries than the manifest bounds, truncating nothing', async () => {
    const persistence = sink();
    const result = await runFeedPass({
      root,
      manifest: manifest({ maxFiles: 2 }),
      reader: reader({}).read,
      directory: directory(['a.csv', 'b.csv', 'c.csv']).lister,
      sink: persistence.ingest,
    });
    assert.equal(refused(result), 'too_many_entries');
    assert.deepEqual(persistence.submissions, []);
  });

  it('refuses a root it cannot enumerate rather than reporting an empty pass', async () => {
    const result = await runFeedPass({
      root,
      manifest: manifest(),
      reader: reader({}).read,
      directory: { list: async () => { throw new Error('ENOENT'); } },
      sink: sink().ingest,
    });
    assert.equal(refused(result), 'root_unreadable');
  });
});

describe('per-file refusals name their stage and reach no database', () => {
  it('never opens a file the manifest did not declare', async () => {
    const files = reader({ 'stock.xlsx': bytes('PK'), 'part-a.csv': bytes(CSV) });
    const persistence = sink();
    const result = await runFeedPass({
      root, manifest: manifest(), reader: files.read,
      directory: directory(['part-a.csv', 'stock.xlsx']).lister, sink: persistence.ingest,
    });

    const undeclared = decisions(result).find((decision) => decision.relativePath === 'stock.xlsx');
    assert.deepEqual(rejectionOf(undeclared!), { stage: 'manifest', reason: 'not_in_manifest' });
    assert.deepEqual(files.opened.map((entry) => entry.relativePath), ['part-a.csv']);
    assert.equal(persistence.submissions.length, 1);
  });

  it('reports a directory entry that is not a regular file without reading it', async () => {
    const files = reader({});
    const result = await runFeedPass({
      root, manifest: manifest(), reader: files.read,
      directory: directory([{ name: 'nested', kind: 'other' }]).lister, sink: sink().ingest,
    });
    const entry = decisions(result).find((decision) => decision.relativePath === 'nested');
    assert.deepEqual(rejectionOf(entry!), { stage: 'enumeration', reason: 'not_a_regular_file' });
    assert.deepEqual(files.opened, []);
  });

  it('reports a manifest file that is absent from the root instead of silently skipping it', async () => {
    const result = await runFeedPass({
      root,
      manifest: manifest(),
      reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory([]).lister,
      sink: sink().ingest,
    });
    const missing = decisions(result).find((decision) => decision.relativePath === 'part-a.csv');
    assert.deepEqual(rejectionOf(missing!), { stage: 'enumeration', reason: 'file_absent' });
  });

  it('refuses hostile content at its own stage and persists nothing for that file', async () => {
    const hostile = 'ITEM_CODE,QTY_ON_HAND,UOM\n"=cmd|\' /c calc\'!A0",1,box\n';
    const persistence = sink();
    const result = await runFeedPass({
      root, manifest: manifest(), reader: reader({ 'part-a.csv': bytes(hostile) }).read,
      directory: directory(['part-a.csv']).lister, sink: persistence.ingest,
    });
    assert.deepEqual(rejectionOf(decisions(result)[0]!), { stage: 'parse', reason: 'unsafe_cell' });
    assert.deepEqual(persistence.submissions, []);
  });

  it('refuses a decompression bomb before it reaches persistence', async () => {
    const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024, 0x41)));
    const persistence = sink();
    const result = await runFeedPass({
      root,
      manifest: manifest({
        maxDecompressedBytes: 64 * 1024,
        files: [{ relativePath: 'part-a.csv.gz', partitionKey: 'part-a', format: 'delimited', compressed: true }],
      }),
      reader: reader({ 'part-a.csv.gz': bomb }).read,
      directory: directory(['part-a.csv.gz']).lister,
      sink: persistence.ingest,
    });
    assert.deepEqual(rejectionOf(decisions(result)[0]!), { stage: 'decompression', reason: 'output_too_large' });
    assert.deepEqual(persistence.submissions, []);
  });

  it('offers a symlink to the contained reader and reports its containment refusal', async () => {
    const persistence = sink();
    const result = await runFeedPass({
      root, manifest: manifest(),
      reader: { readContained: async () => ({ kind: 'rejected' as const, reason: 'escapes_root' as const, detail: 'part-a.csv' }) },
      directory: directory([{ name: 'part-a.csv', kind: 'link' }]).lister, sink: persistence.ingest,
    });
    assert.deepEqual(rejectionOf(decisions(result)[0]!), { stage: 'read', reason: 'escapes_root' });
    assert.deepEqual(persistence.submissions, []);
  });

  it('lets a symlink that stays inside the root be read like any other file', async () => {
    const persistence = sink();
    const result = await runFeedPass({
      root, manifest: manifest(), reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory([{ name: 'part-a.csv', kind: 'link' }]).lister, sink: persistence.ingest,
    });
    assert.equal(decisions(result)[0]?.kind, 'accepted');
    assert.equal(persistence.submissions.length, 1);
  });

  it('keeps going after one file is refused', async () => {
    const persistence = sink();
    const result = await runFeedPass({
      root,
      manifest: manifest({
        maxFiles: 4,
      }),
      reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory(['bad.csv', 'part-a.csv']).lister,
      sink: persistence.ingest,
    });
    const reported = decisions(result);
    assert.deepEqual(rejectionOf(reported[0]!), { stage: 'manifest', reason: 'not_in_manifest' });
    assert.equal(reported[1]?.kind, 'accepted');
    assert.deepEqual(persistence.submissions.map((submission) => submission.partitionKey), ['part-a']);
  });
});

describe('persistence outcomes are reported, not swallowed', () => {
  it('reports a replayed file as a duplicate rather than a second delivery', async () => {
    const result = await runFeedPass({
      root, manifest: manifest(), reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory(['part-a.csv']).lister,
      sink: sink((submission, call) => ({ ...receipt(submission, call), duplicate: true, projectionRevision: 1 })).ingest,
    });
    const [decision] = decisions(result);
    assert.equal(decision?.kind, 'duplicate');
    assert.equal(decision?.kind === 'duplicate' ? decision.receipt.projectionRevision : 0, 1);
  });

  it('reports a refused write with the code the database raised', async () => {
    const failure = Object.assign(new Error('stale_export'), { code: 'stale_export' });
    const result = await runFeedPass({
      root, manifest: manifest(), reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory(['part-a.csv']).lister,
      sink: sink(() => failure).ingest,
    });
    assert.deepEqual(rejectionOf(decisions(result)[0]!), { stage: 'persistence', reason: 'stale_export' });
  });

  it('does not let one refused write abandon the rest of the pass', async () => {
    const persistence = sink((submission, call) =>
      call === 0 ? Object.assign(new Error('x'), { code: 'changed_content_same_sequence' }) : receipt(submission, call));
    const result = await runFeedPass({
      root,
      manifest: manifest(),
      reader: reader({ 'part-a.csv': bytes(CSV) }).read,
      directory: directory(['part-a.csv']).lister,
      sink: persistence.ingest,
    });
    const reported = decisions(result);
    assert.deepEqual(rejectionOf(reported[0]!), { stage: 'persistence', reason: 'changed_content_same_sequence' });
    assert.equal(reported.length, 1);
  });
});
