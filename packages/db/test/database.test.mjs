import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import { applyMigrations, ensureTestDatabase, psql } from '../scripts/postgres.mjs'

const database = 'pharmacart_test'
const runtimeRole = 'pharmacart_runtime'

const pharmacyA = '10000000-0000-4000-8000-000000000001'
const pharmacyB = '10000000-0000-4000-8000-000000000002'
const supplier = '10000000-0000-4000-8000-000000000003'
const branchA1 = '20000000-0000-4000-8000-000000000001'
const branchA2 = '20000000-0000-4000-8000-000000000002'
const branchB1 = '20000000-0000-4000-8000-000000000003'
const membershipA = '30000000-0000-4000-8000-000000000001'
const membershipB = '30000000-0000-4000-8000-000000000002'
let concurrentResults = []
let initialVersions = new Set()

before(async () => {
  await ensureTestDatabase(database)
  const ledgerExists = (await psql(database, "SELECT to_regclass('schema_migration')")).trim() !== ''
  initialVersions = new Set(ledgerExists ? (await psql(database, 'SELECT version FROM schema_migration')).trim().split('\n') : [])
  concurrentResults = await Promise.all([applyMigrations(database), applyMigrations(database)])
  await psql(database, `
    TRUNCATE app_order, need, membership_branch, membership, branch, organisation CASCADE;
    INSERT INTO organisation (id, kind, name, verification_status) VALUES
      ('${pharmacyA}', 'pharmacy', 'Synthetic Pharmacy A', 'verified'),
      ('${pharmacyB}', 'pharmacy', 'Synthetic Pharmacy B', 'verified'),
      ('${supplier}', 'supplier', 'Synthetic Supplier', 'verified');
    INSERT INTO branch (organisation_id, id, name, timezone) VALUES
      ('${pharmacyA}', '${branchA1}', 'A One', 'Africa/Cairo'),
      ('${pharmacyA}', '${branchA2}', 'A Two', 'Africa/Cairo'),
      ('${pharmacyB}', '${branchB1}', 'B One', 'Africa/Cairo');
    INSERT INTO membership (id, organisation_id, user_subject, role, status) VALUES
      ('${membershipA}', '${pharmacyA}', 'synthetic:user:a', 'purchaser', 'active'),
      ('${membershipB}', '${pharmacyB}', 'synthetic:user:b', 'purchaser', 'active');
    INSERT INTO membership_branch (organisation_id, membership_id, branch_id) VALUES
      ('${pharmacyA}', '${membershipA}', '${branchA1}'),
      ('${pharmacyB}', '${membershipB}', '${branchB1}');
    INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity) VALUES
      ('${pharmacyA}', '${branchA1}', 'SYN-PACK-001', 12),
      ('${pharmacyA}', '${branchA2}', 'SYN-PACK-002', 4),
      ('${pharmacyB}', '${branchB1}', 'SYN-PACK-003', 8);
    INSERT INTO app_order (pharmacy_organisation_id, pharmacy_branch_id, supplier_organisation_id, external_client_ref, state) VALUES
      ('${pharmacyA}', '${branchA1}', '${supplier}', 'SYN-ORDER-A', 'queued'),
      ('${pharmacyB}', '${branchB1}', '${supplier}', 'SYN-ORDER-B', 'queued');
  `)
})

async function asRuntime(sql) {
  return psql(database, `SET ROLE ${runtimeRole}; ${sql}; RESET ROLE;`)
}

test('runtime role is a non-login, non-owner safety role without elevated attributes', async () => {
  const result = await psql(database, `
    SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    FROM pg_roles WHERE rolname = '${runtimeRole}';
  `)
  assert.equal(result.trim(), 'f|f|f|f|f')

  const ownership = await psql(database, `
    SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = '${runtimeRole}' AND c.relname IN ('organisation','branch','membership','need','app_order');
  `)
  assert.equal(ownership.trim(), '0')
})

test('private needs are limited to the current tenant and branch', async () => {
  const visible = await asRuntime(`
    BEGIN;
    SET LOCAL app.organisation_id = '${pharmacyA}';
    SET LOCAL app.branch_id = '${branchA1}';
    SELECT string_agg(product_ref, ',' ORDER BY product_ref) FROM need;
    COMMIT
  `)
  assert.equal(visible.trim(), 'SYN-PACK-001')
})

test('shared orders are visible only to a participating party', async () => {
  const pharmacyRows = await asRuntime(`
    BEGIN; SET LOCAL app.organisation_id = '${pharmacyA}'; SET LOCAL app.branch_id = '${branchA1}';
    SELECT string_agg(external_client_ref, ',' ORDER BY external_client_ref) FROM app_order; COMMIT
  `)
  assert.equal(pharmacyRows.trim(), 'SYN-ORDER-A')

  const supplierRows = await asRuntime(`
    BEGIN; SET LOCAL app.organisation_id = '${supplier}'; SET LOCAL app.branch_id = '${branchA1}';
    SELECT string_agg(external_client_ref, ',' ORDER BY external_client_ref) FROM app_order; COMMIT
  `)
  assert.equal(supplierRows.trim(), 'SYN-ORDER-A')

  const supplierWrongBranch = await asRuntime(`
    BEGIN; SET LOCAL app.organisation_id = '${supplier}'; SET LOCAL app.branch_id = '${branchA2}';
    SELECT count(*) FROM app_order; COMMIT
  `)
  assert.equal(supplierWrongBranch.trim(), '0')

  const unrelatedRows = await asRuntime(`
    BEGIN; SET LOCAL app.organisation_id = '${pharmacyB}'; SET LOCAL app.branch_id = '${branchA1}';
    SELECT count(*) FROM app_order; COMMIT
  `)
  assert.equal(unrelatedRows.trim(), '0')
})

test('tenant and branch context disappears after commit and rollback', async () => {
  for (const terminator of ['COMMIT', 'ROLLBACK']) {
    const result = await asRuntime(`
      BEGIN; SET LOCAL app.organisation_id = '${pharmacyA}'; SET LOCAL app.branch_id = '${branchA1}'; ${terminator};
      SELECT current_setting('app.organisation_id', true) || '|'
        || current_setting('app.branch_id', true) || '|'
        || (SELECT count(*) FROM need) || '|'
        || (SELECT count(*) FROM app_order)
    `)
    assert.equal(result.trim(), '||0|0')
  }
})

test('tenant and branch context disappears after a SQL error and rollback in the same session', async () => {
  const result = await psql(database, `
    SET ROLE ${runtimeRole};
    BEGIN;
    SET LOCAL app.organisation_id = '${pharmacyA}';
    SET LOCAL app.branch_id = '${branchA1}';
    SELECT 1 / 0;
    ROLLBACK;
    SELECT current_setting('app.organisation_id', true) || '|'
      || current_setting('app.branch_id', true) || '|'
      || (SELECT count(*) FROM need) || '|'
      || (SELECT count(*) FROM app_order);
    RESET ROLE;
  `, { onErrorStop: false })
  assert.equal(result.trim(), '||0|0')
})

test('cross-organisation and out-of-scope branch writes are rejected', async () => {
  await assert.rejects(
    asRuntime(`
      BEGIN; SET LOCAL app.organisation_id = '${pharmacyA}'; SET LOCAL app.branch_id = '${branchA1}';
      INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity)
      VALUES ('${pharmacyB}', '${branchB1}', 'SYN-DENIED-TENANT', 1); COMMIT
    `),
    /row-level security policy/,
  )

  await assert.rejects(
    asRuntime(`
      BEGIN; SET LOCAL app.organisation_id = '${pharmacyA}'; SET LOCAL app.branch_id = '${branchA1}';
      INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity)
      VALUES ('${pharmacyA}', '${branchA2}', 'SYN-DENIED-BRANCH', 1); COMMIT
    `),
    /row-level security policy/,
  )
})

test('composite foreign keys reject a branch paired with the wrong organisation', async () => {
  await assert.rejects(
    psql(database, `
      INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity)
      VALUES ('${pharmacyB}', '${branchA1}', 'SYN-BAD-FK', 1)
    `),
    /foreign key constraint/,
  )

  await assert.rejects(
    psql(database, `
      INSERT INTO membership_branch (organisation_id, membership_id, branch_id)
      VALUES ('${pharmacyA}', '${membershipA}', '${branchB1}')
    `),
    /foreign key constraint/,
  )
})

test('organisation kind constraints reject reversed order parties', async () => {
  await assert.rejects(
    psql(database, `
      INSERT INTO app_order (pharmacy_organisation_id, pharmacy_branch_id, supplier_organisation_id, external_client_ref, state)
      VALUES ('${pharmacyA}', '${branchA1}', '${pharmacyB}', 'SYN-BAD-SUPPLIER', 'queued')
    `),
    /foreign key constraint/,
  )
})

test('need quantities reject PostgreSQL non-finite numeric values', async () => {
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    await assert.rejects(psql(database, `
      BEGIN;
      INSERT INTO need (organisation_id, branch_id, product_ref, requested_quantity)
      VALUES ('${pharmacyA}', '${branchA1}', 'SYN-NONFINITE', '${value}'::numeric);
      ROLLBACK;
    `), /check constraint/)
  }
})

test('migration runner skips the same hash and rejects a changed ledger hash', async () => {
  for (const { version } of concurrentResults[0]) {
    const statuses = concurrentResults.map((results) => results.find((result) => result.version === version).status).sort()
    assert.deepEqual(statuses, initialVersions.has(version) ? ['skipped', 'skipped'] : ['applied', 'skipped'])
  }
  const repeated = await applyMigrations(database)
  assert.equal(repeated.every(({ status }) => status === 'skipped'), true)

  const version = '0001_identity_and_tenant_isolation.sql'
  const actualHash = (await psql(database, `SELECT source_hash FROM schema_migration WHERE version = '${version}'`)).trim()
  await psql(database, `UPDATE schema_migration SET source_hash = repeat('0', 64) WHERE version = '${version}'`)
  try {
    await assert.rejects(applyMigrations(database), /Migration source hash changed after apply/)
  } finally {
    await psql(database, `UPDATE schema_migration SET source_hash = '${actualHash}' WHERE version = '${version}'`)
  }
})
