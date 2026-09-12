import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  isPathWithinRoot,
  resolveContainedPath,
  resolveContainedRealPath,
} from '../src/path-boundary.ts';

const root = path.resolve('/srv/pharmacart/feed-drop');

function rejectionReason(untrustedPath: string): string {
  const decision = resolveContainedPath(root, untrustedPath);
  assert.equal(decision.kind, 'rejected', `expected rejection for ${JSON.stringify(untrustedPath)}`);
  return decision.kind === 'rejected' ? decision.reason : '';
}

describe('allowlisted root containment', () => {
  it('accepts a nested relative path and resolves it inside the root', () => {
    const decision = resolveContainedPath(root, 'branch-01/inventory/2026-09-12.csv');
    assert.equal(decision.kind, 'accepted');
    assert.equal(
      decision.kind === 'accepted' ? decision.absolutePath : '',
      path.join(root, 'branch-01', 'inventory', '2026-09-12.csv'),
    );
    assert.equal(
      decision.kind === 'accepted' ? decision.relativePath : '',
      'branch-01/inventory/2026-09-12.csv',
    );
  });

  it('rejects parent traversal expressed with forward or backward separators', () => {
    assert.equal(rejectionReason('../secrets.env'), 'relative_segment');
    assert.equal(rejectionReason('..\\..\\secrets.env'), 'relative_segment');
    assert.equal(rejectionReason('feeds/../../infra/.env'), 'relative_segment');
    assert.equal(rejectionReason('./feed.csv'), 'relative_segment');
  });

  it('rejects absolute, drive-qualified and UNC paths', () => {
    assert.equal(rejectionReason('/etc/passwd'), 'absolute_path');
    assert.equal(rejectionReason('\\Windows\\win.ini'), 'absolute_path');
    assert.equal(rejectionReason('C:\\Windows\\win.ini'), 'drive_qualified_path');
    assert.equal(rejectionReason('c:feed.csv'), 'drive_qualified_path');
    assert.equal(rejectionReason('\\\\attacker\\share\\feed.csv'), 'unc_path');
    assert.equal(rejectionReason('//attacker/share/feed.csv'), 'unc_path');
    assert.equal(rejectionReason('/\\attacker/share'), 'unc_path');
  });

  it('rejects null bytes and control characters used to truncate or forge names', () => {
    assert.equal(rejectionReason('feed.csv\u0000/../../infra/.env'), 'control_character');
    assert.equal(rejectionReason('feed\n.csv'), 'control_character');
    assert.equal(rejectionReason('feed\u007f.csv'), 'control_character');
  });

  it('rejects Windows reserved device names with or without an extension', () => {
    assert.equal(rejectionReason('NUL'), 'reserved_device_name');
    assert.equal(rejectionReason('nul.csv'), 'reserved_device_name');
    assert.equal(rejectionReason('branch-01/COM1.txt'), 'reserved_device_name');
    assert.equal(rejectionReason('CONIN$'), 'reserved_device_name');
  });

  it('rejects alternate data streams, trailing dots and trailing spaces', () => {
    assert.equal(rejectionReason('feed.csv:secrets'), 'stream_separator');
    assert.equal(rejectionReason('feed.csv.'), 'trailing_dot_or_space');
    assert.equal(rejectionReason('feed.csv '), 'trailing_dot_or_space');
  });

  it('rejects empty input, empty segments and oversized names', () => {
    assert.equal(rejectionReason(''), 'empty_path');
    assert.equal(rejectionReason('feeds//feed.csv'), 'empty_segment');
    assert.equal(rejectionReason('branch-01/'), 'empty_segment');
    assert.equal(rejectionReason(`${'a'.repeat(1025)}.csv`), 'path_too_long');
    assert.equal(rejectionReason(`branch/${'a'.repeat(256)}.csv`), 'segment_too_long');
  });

  it('treats a sibling directory sharing the root prefix as outside the root', () => {
    assert.equal(isPathWithinRoot(root, path.join(root, 'feed.csv')), true);
    assert.equal(isPathWithinRoot(root, `${root}back${path.sep}feed.csv`), false);
    assert.equal(isPathWithinRoot(root, root), false);
    assert.equal(isPathWithinRoot(root, path.dirname(root)), false);
  });
});

describe('symlink-aware root containment', () => {
  let base = '';

  before(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmacart-path-'));
    await fs.mkdir(path.join(base, 'drop', 'branch-01'), { recursive: true });
    await fs.mkdir(path.join(base, 'outside'), { recursive: true });
    await fs.writeFile(path.join(base, 'drop', 'branch-01', 'feed.csv'), 'ok', 'utf8');
    await fs.writeFile(path.join(base, 'outside', 'secrets.env'), 'token', 'utf8');
  });

  after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('accepts a real file inside the root and a not-yet-created sibling', async () => {
    const dropRoot = path.join(base, 'drop');
    const existing = await resolveContainedRealPath(dropRoot, 'branch-01/feed.csv');
    assert.equal(existing.kind, 'accepted');

    const pending = await resolveContainedRealPath(dropRoot, 'branch-01/not-written-yet.csv');
    assert.equal(pending.kind, 'accepted');
  });

  it('rejects a symlink that escapes the root', async (t) => {
    const dropRoot = path.join(base, 'drop');
    try {
      await fs.symlink(path.join(base, 'outside', 'secrets.env'), path.join(dropRoot, 'escape.csv'));
    } catch {
      t.skip('symlink creation is not permitted in this environment');
      return;
    }

    const decision = await resolveContainedRealPath(dropRoot, 'escape.csv');
    assert.equal(decision.kind, 'rejected');
    assert.equal(decision.kind === 'rejected' ? decision.reason : '', 'escapes_root');
  });

  it('rejects string-level hostile input before touching the filesystem', async () => {
    const decision = await resolveContainedRealPath(path.join(base, 'drop'), '../outside/secrets.env');
    assert.equal(decision.kind, 'rejected');
    assert.equal(decision.kind === 'rejected' ? decision.reason : '', 'relative_segment');
  });
});
