import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';

import { applyMigrations, ensureTestDatabase, psql } from '../scripts/postgres.mjs';
import { configureRuntimeLogin } from '../scripts/runtime-setup.mjs';
import {
  createRuntimePool,
  MembershipAccessDeniedError,
  withTransaction,
} from '../src/runtime.ts';

const database = 'pharmacart_test';
const pharmacy = '11000000-0000-4000-8000-000000000001';
const otherPharmacy = '11000000-0000-4000-8000-000000000002';
const branch = '21000000-0000-4000-8000-000000000001';
const otherBranch = '21000000-0000-4000-8000-000000000002';
const membership = '31000000-0000-4000-8000-000000000001';
const subject = 'synthetic:runtime:owner';
let pool: Pool;

before(async () => {
  await ensureTestDatabase(database);
  await applyMigrations(database);
  await psql(database, `
    TRUNCATE app_order, need, membership_branch, membership, branch, organisation CASCADE;
    INSERT INTO organisation (id, kind, name, verification_status) VALUES
      ('${pharmacy}', 'pharmacy', 'Runtime Pharmacy', 'verified'),
      ('${otherPharmacy}', 'pharmacy', 'Other Runtime Pharmacy', 'verified');
    INSERT INTO branch (organisation_id, id, name, timezone) VALUES
      ('${pharmacy}', '${branch}', 'Runtime Branch', 'Asia/Bahrain'),
      ('${otherPharmacy}', '${otherBranch}', 'Other Runtime Branch', 'Asia/Bahrain');
    INSERT INTO membership (id, organisation_id, user_subject, role, status) VALUES
      ('${membership}', '${pharmacy}', '${subject}', 'pharmacy_owner', 'active');
    INSERT INTO membership_branch (organisation_id, membership_id, branch_id)
    VALUES ('${pharmacy}', '${membership}', '${branch}');
    INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity)
    VALUES ('${pharmacy}', '${branch}', 'SYN-RUNTIME-PACK', 2);
  `);
  const runtime = await configureRuntimeLogin(database);
  pool = await createRuntimePool({ connectionString: runtime.connectionString, max: 1 });
});

after(async () => {
  await pool?.end();
});

test('runtime pool connects with a restricted non-owner login that assumes the NOLOGIN role locally', async () => {
  const login = await pool.query(`
    SELECT current_user, session_user,
      (SELECT concat(rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit)
         FROM pg_roles WHERE rolname = session_user) AS attributes
  `);
  assert.deepEqual(login.rows[0], {
    current_user: 'pharmacart_app',
    session_user: 'pharmacart_app',
    attributes: 'tfffff',
  });

  await withTransaction(pool, subject, pharmacy, branch, async (client) => {
    const role = await client.query('SELECT current_user, session_user');
    assert.deepEqual(role.rows[0], {
      current_user: 'pharmacart_runtime',
      session_user: 'pharmacart_app',
    });
  });
});

test('authenticated transaction returns the active membership context and only selected-branch rows', async () => {
  await withTransaction(pool, subject, pharmacy, branch, async (client, context) => {
    assert.deepEqual(context, {
      principalKind: 'member',
      userSubject: subject,
      membershipId: membership,
      organisationId: pharmacy,
      organisationKind: 'pharmacy',
      branchId: branch,
      allowedBranchIds: [branch],
      role: 'pharmacy_owner',
      membershipVersion: 1,
    });
    const visible = await client.query('SELECT product_ref FROM need');
    assert.deepEqual(visible.rows, [{ product_ref: 'SYN-RUNTIME-PACK' }]);
  });
});

test('subject, organisation, and branch selectors cannot grant membership authority', async () => {
  for (const selectors of [
    ['synthetic:runtime:unknown', pharmacy, branch],
    [subject, otherPharmacy, otherBranch],
    [subject, pharmacy, otherBranch],
    [`${subject}' OR true --`, pharmacy, branch],
  ] as const) {
    await assert.rejects(
      withTransaction(pool, selectors[0], selectors[1], selectors[2], async () => undefined),
      MembershipAccessDeniedError,
    );
  }
});

test('revoked memberships are denied on their next transaction', async () => {
  await psql(database, `UPDATE membership SET status = 'revoked', version = version + 1 WHERE id = '${membership}'`);
  try {
    await assert.rejects(
      withTransaction(pool, subject, pharmacy, branch, async () => undefined),
      MembershipAccessDeniedError,
    );
  } finally {
    await psql(database, `UPDATE membership SET status = 'active', version = version + 1 WHERE id = '${membership}'`);
  }
});

test('transaction-local tenant context is cleared after success and callback failure on a reused connection', async () => {
  await withTransaction(pool, subject, pharmacy, branch, async () => undefined);
  const afterCommit = await pool.query(
    `SELECT current_setting('app.organisation_id', true) AS organisation_id,
            current_setting('app.branch_id', true) AS branch_id`,
  );
  assert.deepEqual(afterCommit.rows[0], { organisation_id: '', branch_id: '' });

  await assert.rejects(
    withTransaction(pool, subject, pharmacy, branch, async () => {
      throw new Error('synthetic callback failure');
    }),
    /synthetic callback failure/,
  );
  const afterRollback = await pool.query(
    `SELECT current_setting('app.organisation_id', true) AS organisation_id,
            current_setting('app.branch_id', true) AS branch_id`,
  );
  assert.deepEqual(afterRollback.rows[0], { organisation_id: '', branch_id: '' });
});
