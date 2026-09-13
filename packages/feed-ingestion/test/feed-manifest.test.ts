import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FEED_MANIFEST_LIMITS,
  readFeedManifest,
  type FeedManifestDecision,
} from '../src/feed-manifest.ts';

function source(overrides: Record<string, unknown> = {}): unknown {
  return {
    installationSubject: 'synthetic:connector:a',
    batchKey: 'export-2026-09-12',
    exportedAt: '2026-09-12T06:30:00Z',
    maxFiles: 4,
    maxInputBytes: 1024 * 1024,
    maxDecompressedBytes: 8 * 1024 * 1024,
    columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
    contract: {
      adapterId: 'synthetic-pos',
      revision: 1,
      sourceCodeNormalization: 'trim',
      unitAliases: { box: 'box', bx: 'box' },
    },
    files: [{ relativePath: 'part-a.csv', partitionKey: 'part-a', format: 'delimited', compressed: false }],
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown>): string {
  const decision: FeedManifestDecision = readFeedManifest(source(overrides));
  assert.equal(decision.kind, 'rejected');
  return decision.kind === 'rejected' ? decision.reason : '';
}

function accepted(overrides: Record<string, unknown> = {}) {
  const decision = readFeedManifest(source(overrides));
  assert.equal(decision.kind, 'accepted', decision.kind === 'rejected' ? `${decision.reason}: ${decision.detail}` : '');
  return decision.kind === 'accepted' ? decision.manifest : (undefined as never);
}

describe('feed manifest is the only source of feed identity', () => {
  it('refuses host-dependent and normalized invalid export dates', () => {
    for (const exportedAt of ['2026-09-12T06:30:00', '2026-09-12', '2026-02-30T06:30:00Z']) {
      assert.equal(refusal({ exportedAt }), 'invalid_exported_at');
    }
  });

  it('refuses multi-file batches before a single-file worker can partially accept them', () => {
    assert.equal(refusal({ files: [
      { relativePath: 'a.csv', partitionKey: 'a', format: 'delimited', compressed: false },
      { relativePath: 'b.csv', partitionKey: 'b', format: 'delimited', compressed: false },
    ] }), 'multipart_batch_unsupported');
  });
  it('carries the export instant and batch key the operator declared', () => {
    const manifest = accepted();
    assert.equal(manifest.exportedAt, '2026-09-12T06:30:00Z');
    assert.equal(manifest.batchKey, 'export-2026-09-12');
    assert.deepEqual(manifest.files.map((file) => file.partitionKey), ['part-a']);
  });

  it('refuses a manifest that omits the export instant rather than reaching for a clock', () => {
    assert.equal(refusal({ exportedAt: undefined }), 'missing_field');
    assert.equal(refusal({ exportedAt: 'yesterday' }), 'invalid_exported_at');
    assert.equal(refusal({ exportedAt: '' }), 'missing_field');
    assert.equal(refusal({ batchKey: undefined }), 'missing_field');
  });

  it('defaults the delimiter but never the byte caps', () => {
    assert.equal(accepted().delimiter, ',');
    assert.equal(accepted({ delimiter: ';' }).delimiter, ';');
    assert.equal(refusal({ maxInputBytes: undefined }), 'missing_field');
    assert.equal(refusal({ maxDecompressedBytes: undefined }), 'missing_field');
    assert.equal(refusal({ maxInputBytes: 0 }), 'invalid_byte_limit');
    assert.equal(refusal({ maxInputBytes: 1.5 }), 'invalid_byte_limit');
    assert.equal(refusal({ maxInputBytes: FEED_MANIFEST_LIMITS.maxInputBytes + 1 }), 'invalid_byte_limit');
    assert.equal(refusal({ maxDecompressedBytes: FEED_MANIFEST_LIMITS.maxDecompressedBytes + 1 }), 'invalid_byte_limit');
  });

  it('bounds the file count the pass is allowed to enumerate', () => {
    assert.equal(refusal({ maxFiles: undefined }), 'missing_field');
    assert.equal(refusal({ maxFiles: 0 }), 'invalid_file_count');
    assert.equal(refusal({ maxFiles: FEED_MANIFEST_LIMITS.maxFiles + 1 }), 'invalid_file_count');
    assert.equal(
      refusal({
        maxFiles: 1,
        files: [
          { relativePath: 'a.csv', partitionKey: 'a', format: 'delimited', compressed: false },
          { relativePath: 'b.csv', partitionKey: 'b', format: 'delimited', compressed: false },
        ],
      }),
      'too_many_files',
    );
  });

  it('refuses any format it would have to execute to read', () => {
    for (const format of ['workbook', 'xml', 'xlsx', 'ole']) {
      assert.equal(
        refusal({ files: [{ relativePath: 'book.xlsx', partitionKey: 'a', format, compressed: false }] }),
        'unsupported_format',
        format,
      );
    }
  });

  it('refuses a declared path that would escape the drop root', () => {
    for (const relativePath of ['../../infra/.env', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\\..\\..\\b.csv']) {
      assert.equal(
        refusal({ files: [{ relativePath, partitionKey: 'a', format: 'delimited', compressed: false }] }),
        'unsafe_relative_path',
        relativePath,
      );
    }
  });

  it('refuses ambiguous partition identity', () => {
    assert.equal(
      refusal({
        maxFiles: 4,
        files: [
          { relativePath: 'a.csv', partitionKey: 'same', format: 'delimited', compressed: false },
          { relativePath: 'b.csv', partitionKey: 'same', format: 'delimited', compressed: false },
        ],
      }),
      'duplicate_partition_key',
    );
    assert.equal(
      refusal({
        maxFiles: 4,
        files: [
          { relativePath: 'a.csv', partitionKey: 'a', format: 'delimited', compressed: false },
          { relativePath: 'a.csv', partitionKey: 'b', format: 'delimited', compressed: false },
        ],
      }),
      'duplicate_relative_path',
    );
    assert.equal(refusal({ files: [] }), 'no_files');
  });

  it('refuses to run against anything that is not a synthetic local identity', () => {
    assert.equal(refusal({ installationSubject: 'connector:acme-pharmacy' }), 'non_synthetic_subject');
    assert.equal(refusal({ installationSubject: '' }), 'missing_field');
    assert.equal(refusal({ installationSubject: 42 }), 'invalid_field');
  });

  it('refuses input that is not a manifest at all', () => {
    for (const value of [null, 'text', 7, []]) {
      const decision = readFeedManifest(value);
      assert.equal(decision.kind, 'rejected');
      assert.equal(decision.kind === 'rejected' ? decision.reason : '', 'not_an_object');
    }
    assert.equal(refusal({ columns: { sourceCode: 'a', quantity: 'b' } }), 'invalid_field');
    assert.equal(refusal({ contract: { adapterId: 'x', revision: 1, sourceCodeNormalization: 'shout', unitAliases: {} } }), 'invalid_field');
    assert.equal(refusal({ contract: { adapterId: 'x', revision: 1, sourceCodeNormalization: 'trim', unitAliases: { box: 3 } } }), 'invalid_field');
  });

  it('does not let a manifest smuggle extra behaviour past the validator', () => {
    const manifest = accepted({ deleteAfterIngest: true, watch: true, useFileModifiedTime: true });
    assert.equal(Object.hasOwn(manifest, 'deleteAfterIngest'), false);
    assert.equal(Object.hasOwn(manifest, 'watch'), false);
    assert.equal(Object.hasOwn(manifest, 'useFileModifiedTime'), false);
  });
});
