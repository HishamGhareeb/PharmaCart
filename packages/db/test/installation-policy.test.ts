import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { emptyInventorySnapshotState } from '../../domain/src/inventory-snapshot.ts';
import { ingestInventory, InventoryError, type InventoryCommand } from '../src/inventory.ts';

// Policy-ordering regression for the authenticated inventory path. It runs no
// database: a recording client stands in for PostgreSQL so the statement order
// around authorisation, the per-installation lock and the post-lock recheck is
// asserted directly. The real lifecycle behaviour is covered by installation.test.ts.

const subject = 'synthetic:connector:a';
const ids = {
  installation: '50000000-0000-4000-8000-000000000001',
  organisation: '10000000-0000-4000-8000-000000000001',
  branch: '20000000-0000-4000-8000-000000000001',
};
const command: InventoryCommand = {
  kind: 'partition', eventId: 'event-1', snapshotId: 'snap-1', sequence: 1, partitionId: 'p1',
  rows: [{ sourceCode: '00017', quantity: '8', unit: 'box' }],
};

type StoredStatus = 'pending' | 'active' | 'suspended' | 'revoked';

function lifecycleRow(status: StoredStatus) {
  return {
    id: ids.installation, organisation_id: ids.organisation, branch_id: ids.branch, status,
    paired_at: status === 'pending' ? null : new Date('2026-01-01T00:00:00.000Z'),
    status_changed_at: new Date('2026-02-01T00:00:00.000Z'),
    status_reason: status === 'suspended' || status === 'revoked' ? 'synthetic-stolen-laptop' : null,
    supersedes_installation_id: null,
  };
}

// Each entry answers one lifecycle lookup in order; the last entry repeats.
function recordingPool(lookups: readonly (StoredStatus | 'missing')[]) {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  let lookup = 0;
  let released = 0;
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      statements.push({ text, values });
      if (text.includes('pharmacart_installation_lifecycle')) {
        const status = lookups[Math.min(lookup, lookups.length - 1)] ?? 'missing';
        lookup += 1;
        const rows = status === 'missing' ? [] : [lifecycleRow(status)];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ state: JSON.stringify(emptyInventorySnapshotState()) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    statements,
    texts: () => statements.map(statement => statement.text),
    lookupCount: () => lookup,
    releaseCount: () => released,
  };
}

const writes = /inventory_inbox|inventory_projection|INSERT INTO inventory_state|inventory_alert|INSERT INTO need/;

async function denial(status: StoredStatus | 'missing') {
  const recorded = recordingPool([status]);
  const error = await ingestInventory(recorded.pool, subject, command).then(
    () => { throw new Error(`expected ${status} to be denied`); },
    (caught: unknown) => caught,
  );
  assert(error instanceof InventoryError, `expected InventoryError, received ${String(error)}`);
  assert.equal(error.code, 'INSTALLATION_DENIED');
  return { recorded, error };
}

test('AC-016: a lifecycle that does not permit submit_inventory is denied before any write', async () => {
  for (const status of ['pending', 'suspended', 'revoked', 'missing'] as const) {
    const { recorded } = await denial(status);
    const texts = recorded.texts();
    assert.deepEqual(texts.filter(text => writes.test(text)), [], `${status} reached a write`);
    assert.deepEqual(texts.filter(text => text.includes('FOR UPDATE')), [], `${status} locked inventory state`);
    assert.equal(texts.at(-1), 'ROLLBACK');
    assert.equal(recorded.releaseCount(), 1);
    assert.equal(recorded.lookupCount(), 1);
  }
});

test('AC-016: the denial carries the stored status and its sync directive', async () => {
  assert.deepEqual((await denial('pending')).error.refusal,
    { status: 'pending', reason: 'pairing_incomplete', directive: 'pause' });
  assert.deepEqual((await denial('suspended')).error.refusal,
    { status: 'suspended', reason: 'installation_suspended', directive: 'pause' });
  assert.deepEqual((await denial('revoked')).error.refusal,
    { status: 'revoked', reason: 'installation_revoked', directive: 'stop' });
  assert.deepEqual((await denial('missing')).error.refusal,
    { status: 'unknown', reason: 'installation_unknown', directive: 'stop' });
});

test('AC-016: an active installation is authorised from stored scope and rechecked after the lock', async () => {
  const recorded = recordingPool(['active']);
  const result = await ingestInventory(recorded.pool, subject, command);
  assert.equal(result.status, 'processed');
  const texts = recorded.texts();
  const first = texts.findIndex(text => text.includes('pharmacart_installation_lifecycle'));
  const locked = texts.findIndex(text => text.includes('FOR UPDATE'));
  const recheck = texts.findLastIndex(text => text.includes('pharmacart_installation_lifecycle'));
  const inbox = texts.findIndex(text => text.includes('inventory_inbox'));
  assert(first >= 0 && locked > first, 'the lifecycle is read before the inventory lock');
  assert(recheck > locked, 'the lifecycle is read again after waiting for the inventory lock');
  assert(inbox > recheck, 'the inbox write happens after the recheck');
  assert.equal(recorded.lookupCount(), 2);
  assert.equal(texts.at(-1), 'COMMIT');
  for (const statement of recorded.statements.filter(entry => entry.text.includes('pharmacart_installation_lifecycle'))) {
    assert.deepEqual(statement.values, [subject], 'the lookup is bound to the authenticated subject only');
  }
  // Scope is taken from the stored row, never from the caller.
  const inboxValues = recorded.statements.find(entry => entry.text.includes('inventory_inbox'))?.values ?? [];
  assert.deepEqual(inboxValues.slice(0, 3), [ids.installation, ids.organisation, ids.branch]);
});

test('AC-016: a revocation observed after the inventory lock stops the pending write', async () => {
  const recorded = recordingPool(['active', 'revoked']);
  await assert.rejects(ingestInventory(recorded.pool, subject, command),
    (error: unknown) => error instanceof InventoryError && error.code === 'INSTALLATION_DENIED');
  const texts = recorded.texts();
  assert(texts.some(text => text.includes('FOR UPDATE')), 'the lock was taken before the recheck');
  assert.deepEqual(texts.filter(text => writes.test(text) && !text.includes('INSERT INTO inventory_state')), []);
  assert.equal(texts.at(-1), 'ROLLBACK');
  assert.equal(recorded.releaseCount(), 1);
});
