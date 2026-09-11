# Authenticated database runtime evidence

This B0/B1 prerequisite adds a PostgreSQL client pool that connects as the dedicated `pharmacart_app` login. Pool creation checks the live role attributes and refuses to start unless the login is non-superuser, cannot bypass RLS, cannot create roles or databases, uses `NOINHERIT`, and can assume the existing `pharmacart_runtime` `NOLOGIN` privilege role.

Each `withTransaction` call accepts the authenticated subject and organisation/branch selectors separately from request bodies. It begins a transaction, assumes `pharmacart_runtime` with `SET LOCAL ROLE`, calls the narrow `pharmacart_active_membership` security-definer function, sets parameterized transaction-local RLS context, and rechecks the active membership before invoking application code. The function has a fixed `pg_catalog` search path, fully qualified relations, no public execute permission, and returns only membership authorization fields.

Runtime credentials are generated locally into the already ignored `infra/.env` as `PHARMACART_RUNTIME_DB_PASSWORD`. The setup script does not print the password or database URL. Application code accepts only `PHARMACART_RUNTIME_DATABASE_URL` using the `pharmacart_app` username; it never reads bootstrap credentials.

The real PostgreSQL tests cover restricted login attributes, local privilege-role assumption, owner-role mapping, membership-derived context, tenant/branch RLS visibility, selector and SQL-injection denial, next-transaction revocation, and pooled context cleanup after commit and rollback. They use no RLS mocks. Because the database foundation suite resets the same synthetic tables, integration execution must use one test process with concurrency disabled.

This evidence is bounded to the database runtime prerequisite. It does not establish OIDC validation, HTTP behavior, or AC-001/AC-016 PASS.

