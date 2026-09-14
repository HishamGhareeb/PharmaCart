import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { filesystemFeedDirectory } from '../src/feed-worker.ts';

describe('bounded filesystem feed directory', () => {
  it('lists regular entries within the configured bound', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pharmacart-feed-'));
    try {
      await writeFile(path.join(root, 'a.csv'), 'a');
      await writeFile(path.join(root, 'b.csv'), 'b');
      const entries = await filesystemFeedDirectory.list(root, 2);
      assert.deepEqual(entries.map((entry) => entry.name).sort(), ['a.csv', 'b.csv']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops after maxFiles plus one so the pass can refuse without unbounded enumeration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pharmacart-feed-'));
    try {
      await Promise.all(['a.csv', 'b.csv', 'c.csv'].map((name) => writeFile(path.join(root, name), name)));
      const entries = await filesystemFeedDirectory.list(root, 2);
      assert.equal(entries.length, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-finite or over-ceiling bound before opening the directory', async () => {
    await assert.rejects(() => filesystemFeedDirectory.list('.', Number.POSITIVE_INFINITY), /invalid directory entry limit/);
    await assert.rejects(() => filesystemFeedDirectory.list('.', 1025), /invalid directory entry limit/);
  });
});
