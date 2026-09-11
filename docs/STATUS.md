# PharmaCart current build status

Date: 2026-09-11. This file is the current status; docs/testing contains historical evidence.

Latest verification: 54 unit/contract tests and 10 PostgreSQL integration tests pass; strict types, lint, schema verification, clean install and audit pass. A local backup/restore was verified. Details: testing/foundation-integration.md.

## Delivered

- Node/npm and development tooling pinned with a lockfile; strict type checks, lint, schema generation/verification and coverage commands.
- JSON Schema 2020-12 contract sources; generated TypeScript carries a source hash. Generator derives object properties and discriminated unions, rejects unsupported schema constructs, and detects recursive refs.
- Strict decimal, approval-command and supplier-response validation. Automatic retry needs positive lookup evidence and separate trusted capability permission.
- Invented, deterministic fixtures with canonical UUIDs and decimals; independent instances per test.
- Pure commercial-pack identity matching and immutable multipart snapshot processing. Late snapshots cannot replace newer state; installation-scoped event replay is idempotent.
- Digest-pinned local PostgreSQL 17.10, loopback port 55432, two applied migrations, forced RLS and a non-owner runtime role.
- Real database tests for tenant/branch visibility, shared order parties, context cleanup after commit/rollback/error, cross-tenant writes, foreign keys, finite quantities and repeat/concurrent migration handling.

## Boundary

No full AC is marked PASS. B0 still lacks the API/OpenAPI surface, local OIDC provider and full development/build commands. B1 lacks authenticated API checks and durable inbox/projections; in-memory snapshot rules do not survive restart. B2/B3 quote, budget, approval transactions, fake-supplier dispatch, receipts and recovery workflows remain to build. Mobile, web and desktop applications have not begun.

The database context functions deliberately trust backend-supplied context. Future request middleware must verify active membership and relationship-scoped branch authority on every request. Never expose SQL/bootstrap credentials to clients or treat an organisation ID as proof of access.

## Team and continuation

GPT-6 Astra coordinates and reviews. Three GPT-5.6 Sol workstreams produced contract, database and ingestion code. They hit an account usage limit; Astra completed the interrupted integration and regression fixes. No reset credits or paid services were used.

Next order: authenticated API/local OIDC and durable ingestion; then transactional quote/approval; then fake-supplier acknowledgement/receipt and recovery. Vendor access and production publication remain separate explicit authorization gates.
