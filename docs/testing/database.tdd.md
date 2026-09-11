# Database foundation evidence

The Sol workstream introduced migration/tenant-isolation tests; its final turn was interrupted by a usage limit. Astra reviewed and completed the work.

Observed RED: `npm run test:integration` ran 10 tests with 8 PASS and 2 FAIL. A need accepted PostgreSQL `NaN`; the migration test assumed every invocation began with an empty ledger and failed on repeat execution.

Fix: additive migration 0002 rejects NaN and both infinities, normalizes the pharmacy owner role and removes unnecessary sequence grants. Test expectations distinguish an existing ledger from first application. The first regression's known synthetic row was removed only from `pharmacart_test`; no customer data exists or was touched.

Observed GREEN: `npm run test:integration` passed all 10 tests with zero skips, then passed all 10 on a repeat invocation. Both migrations applied successfully to the separate local `pharmacart` development database.

Covered: non-elevated/non-owner runtime role, tenant and branch RLS, explicit shared-order party/branch access, context cleanup after commit/rollback/error in the same SQL session, forbidden writes, composite foreign keys and party kinds, finite quantities, locked migration idempotency and changed-hash refusal.

This does not prove OIDC, request-level authorization, a Node connection pool, role-based business permissions or full AC-001/AC-016. Local test/admin scripts use the bootstrap account and explicitly switch to the runtime role for RLS assertions.
