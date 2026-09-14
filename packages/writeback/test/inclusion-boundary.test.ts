import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

// RELEASE-GATE boundary: an applied writeback is delivery evidence only. It does not prove that a later
// inventory snapshot contains the received stock, so writeback code must never record inclusion. A
// separate inclusion writer sets those columns from a feed snapshot. This static guard runs without a
// database and fails the moment a writeback source file so much as names an inclusion column; the database
// suite separately asserts that the columns stay NULL after a real delivery.

const root = new URL('../../../', import.meta.url);
const inclusionColumns = /included_snapshot_id|included_sequence/i;

async function writebackSources(): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  const packageSources = new URL('packages/writeback/src/', root);
  for (const name of await readdir(packageSources)) {
    if (name.endsWith('.ts')) sources[`packages/writeback/src/${name}`] = await readFile(new URL(name, packageSources), 'utf8');
  }
  for (const path of ['packages/db/src/writeback.ts', 'packages/db/migrations/0018_writeback_attempts.sql']) {
    sources[path] = await readFile(new URL(path, root), 'utf8');
  }
  return sources;
}

test('no writeback source names a receipt inclusion column', async () => {
  const sources = await writebackSources();
  assert.ok(Object.keys(sources).length >= 5, 'the guard must actually be reading the writeback sources');
  for (const [path, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, inclusionColumns, `${path} must not read or write receipt inclusion; that belongs to the inclusion writer`);
  }
});

test('the writeback processor changes nothing on receipt_writeback except queued to applied', async () => {
  const source = (await writebackSources())['packages/db/src/writeback.ts']!;
  const updates = [...source.matchAll(/UPDATE\s+receipt_writeback\s+SET\s+([\s\S]*?)\s+WHERE/gi)].map((match) => match[1]!.replace(/\s+/g, ''));
  assert.deepEqual(updates, ["status='applied'"], 'the only permitted write to receipt_writeback is the delivery status');
  assert.doesNotMatch(source, /INSERT\s+INTO\s+receipt_writeback\s*\(/i, 'writeback must never create queue rows; confirmReceipt owns that');
  assert.doesNotMatch(source, /DELETE\s+FROM/i, 'writeback history is evidence and is never deleted');
  // Replenishment state is another lane's. Recording delivery must not touch it.
  assert.doesNotMatch(source, /\b(?:UPDATE|INSERT\s+INTO)\s+(?:need|inventory\w*|alert\w*|order_line|receipt)\b(?!_)/i);
});
