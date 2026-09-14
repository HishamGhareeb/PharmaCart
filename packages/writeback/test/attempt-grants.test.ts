import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Least privilege for receipt_writeback_attempt: the runtime role may UPDATE exactly the columns the
// processor writes, and nothing that fixes an attempt's identity, tenant, stock receipt key, recorded
// payload or creation time. This reads every UPDATE, including INSERT ... ON CONFLICT DO UPDATE, from the
// processor source and compares it with the column-level grant in the migration, so a new write fails here
// before it fails at runtime, and a widened grant fails here before it is merged. The database suite proves
// the grant is enforced.

const root = new URL('../../../', import.meta.url);
const protectedColumns = ['writeback_id', 'organisation_id', 'branch_id', 'sink_key', 'payload_hash', 'created_at'];

function assignedColumns(clause: string): string[] {
  return [...clause.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((match) => match[1]!);
}

test('the attempt UPDATE grant is exactly the set of columns the processor writes', async () => {
  const source = await readFile(new URL('packages/db/src/writeback.ts', root), 'utf8');
  const migration = await readFile(new URL('packages/db/migrations/0018_writeback_attempts.sql', root), 'utf8');

  const direct = [...source.matchAll(/UPDATE\s+receipt_writeback_attempt\s+SET\s+([\s\S]*?)\s+WHERE\b/gi)].map((match) => match[1]!);
  const upserts = [...source.matchAll(/INSERT\s+INTO\s+receipt_writeback_attempt\b[\s\S]*?DO\s+UPDATE\s+SET\s+([\s\S]*?)`/gi)].map((match) => match[1]!);
  assert.ok(direct.length >= 5 && upserts.length >= 2, `the guard must be reading the processor's updates (found ${direct.length} updates, ${upserts.length} upserts)`);
  const written = new Set([...direct, ...upserts].flatMap(assignedColumns));

  const grants = [...migration.matchAll(/GRANT\s+([^;]*?)\s+ON\s+receipt_writeback_attempt\s+TO\s+pharmacart_runtime/gi)].map((match) => match[1]!);
  assert.ok(grants.length > 0, 'the migration must grant the runtime role something on receipt_writeback_attempt');
  for (const grant of grants) {
    assert.doesNotMatch(grant, /\bUPDATE\b(?!\s*\()/i, `a table-wide UPDATE grant is not least privilege: GRANT ${grant}`);
    assert.doesNotMatch(grant, /\b(?:DELETE|TRUNCATE|ALL)\b/i, `attempt history must not be deletable: GRANT ${grant}`);
  }
  const granted = new Set(grants.flatMap((grant) => [...grant.matchAll(/UPDATE\s*\(([^)]*)\)/gi)]
    .flatMap((match) => match[1]!.split(',').map((column) => column.trim()))));

  assert.deepEqual([...granted].sort(), [...written].sort(), 'the UPDATE grant must match the columns the processor writes, no more and no fewer');
  for (const column of protectedColumns) assert.ok(!granted.has(column), `${column} must not be updatable by the runtime role`);
});
