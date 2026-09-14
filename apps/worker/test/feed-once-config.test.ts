import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  FEED_ONCE_LIMITS,
  loadFeedManifestFile,
  parseFeedOnceConfig,
  type FeedOnceConfigDecision,
} from '../src/feed-once-config.ts';

// Startup validation for the one-shot feed pass. Nothing here opens a database:
// the configuration is refused before a pool is created.

const env = { PHARMACART_RUNTIME_DATABASE_URL: 'postgres://pharmacart_app@127.0.0.1:55432/pharmacart' };
const argv = ['--manifest', 'synthetic/manifest.json', '--root', 'synthetic/drop'];

function invalid(decision: FeedOnceConfigDecision) {
  assert.equal(decision.kind, 'invalid');
  return decision.kind === 'invalid' ? decision.reason : '';
}

const manifest = {
  installationSubject: 'synthetic:connector:a',
  batchKey: 'synthetic-export-001',
  exportedAt: '2026-09-12T06:30:00Z',
  maxFiles: 2,
  maxInputBytes: 65536,
  maxDecompressedBytes: 262144,
  columns: { sourceCode: 'ITEM_CODE', quantity: 'QTY_ON_HAND', unit: 'UOM' },
  contract: { adapterId: 'synthetic-pos', revision: 1, sourceCodeNormalization: 'trim', unitAliases: { box: 'box' } },
  files: [{ relativePath: 'part-a.csv', partitionKey: 'part-a', format: 'delimited', compressed: false }],
};

async function withTemp(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pharmacart-feed-once-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('one-shot feed pass configuration', () => {
  it('resolves both paths and applies the default lock bound', () => {
    const decision = parseFeedOnceConfig(argv, env);
    assert.deepEqual(decision, {
      kind: 'valid',
      config: {
        manifestPath: path.resolve('synthetic/manifest.json'),
        root: path.resolve('synthetic/drop'),
        lockTimeoutMs: 5000,
      },
    });
  });

  it('accepts an explicit lock bound within the sink ceiling', () => {
    const decision = parseFeedOnceConfig(argv, { ...env, PHARMACART_FEED_LOCK_TIMEOUT_MS: '750' });
    assert.equal(decision.kind === 'valid' ? decision.config.lockTimeoutMs : 0, 750);
  });

  it('refuses to start in production', () => {
    assert.equal(invalid(parseFeedOnceConfig(argv, { ...env, NODE_ENV: 'production' })), 'production_environment');
  });

  it('refuses a missing runtime database URL before connecting', () => {
    assert.equal(invalid(parseFeedOnceConfig(argv, {})), 'missing_database_url');
    assert.equal(invalid(parseFeedOnceConfig(argv, { PHARMACART_RUNTIME_DATABASE_URL: '' })), 'missing_database_url');
  });

  it('names missing, duplicated, unknown and valueless arguments', () => {
    assert.equal(invalid(parseFeedOnceConfig(['--root', 'drop'], env)), 'missing_argument');
    assert.equal(invalid(parseFeedOnceConfig(['--manifest', 'm.json'], env)), 'missing_argument');
    assert.equal(invalid(parseFeedOnceConfig([...argv, '--root', 'other'], env)), 'duplicate_argument');
    assert.equal(invalid(parseFeedOnceConfig([...argv, '--submit'], env)), 'unknown_argument');
    assert.equal(invalid(parseFeedOnceConfig(['--manifest', 'm.json', '--root'], env)), 'missing_value');
    assert.equal(invalid(parseFeedOnceConfig(['--manifest', '--root', 'drop'], env)), 'missing_value');
    assert.equal(invalid(parseFeedOnceConfig(['--manifest', '', '--root', 'drop'], env)), 'missing_value');
  });

  it('refuses a lock bound that is not a whole number of milliseconds within the ceiling', () => {
    for (const value of ['0', '-5', '1.5', '1e3', 'abc', '', ' 50', String(FEED_ONCE_LIMITS.maxLockTimeoutMs + 1)]) {
      assert.equal(invalid(parseFeedOnceConfig(argv, { ...env, PHARMACART_FEED_LOCK_TIMEOUT_MS: value })),
        'invalid_lock_timeout', JSON.stringify(value));
    }
  });
});

describe('one-shot feed manifest file', () => {
  it('reads and validates a synthetic manifest', async () => {
    await withTemp(async (directory) => {
      const file = path.join(directory, 'manifest.json');
      await writeFile(file, JSON.stringify(manifest));
      const decision = await loadFeedManifestFile(file);
      assert.equal(decision.kind, 'accepted');
      assert.equal(decision.kind === 'accepted' ? decision.manifest.installationSubject : '', 'synthetic:connector:a');
    });
  });

  it('names an unreadable, oversized, non-JSON or invalid manifest', async () => {
    await withTemp(async (directory) => {
      const missing = await loadFeedManifestFile(path.join(directory, 'absent.json'));
      assert.equal(missing.kind === 'rejected' ? missing.reason : '', 'manifest_unreadable');

      const large = path.join(directory, 'large.json');
      await writeFile(large, ' '.repeat(FEED_ONCE_LIMITS.maxManifestBytes + 1));
      const oversized = await loadFeedManifestFile(large);
      assert.equal(oversized.kind === 'rejected' ? oversized.reason : '', 'manifest_too_large');

      const text = path.join(directory, 'text.json');
      await writeFile(text, 'not json');
      const garbled = await loadFeedManifestFile(text);
      assert.equal(garbled.kind === 'rejected' ? garbled.reason : '', 'manifest_not_json');

      const real = path.join(directory, 'real.json');
      await writeFile(real, JSON.stringify({ ...manifest, installationSubject: 'connector:a' }));
      const unsynthetic = await loadFeedManifestFile(real);
      assert.equal(unsynthetic.kind === 'rejected' ? unsynthetic.reason : '', 'non_synthetic_subject');
    });
  });
});
