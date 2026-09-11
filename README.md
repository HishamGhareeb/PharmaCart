# PharmaCart

Local synthetic procurement foundation. GPT-6 Astra owns architecture and integration; GPT-5.6 Sol agents implement bounded modules.

## Run the current foundation

Use Node 24.19.0 and npm 11.17.0. Run `npm ci`, then `npm run typecheck`, `npm run lint`, `npm run contracts:verify`, and `npm run test:coverage`. Node runs the TypeScript tests directly; the pinned TypeScript compiler separately checks types. Ajv independently validates the contract schemas. Regenerate derived types with `npm run contracts:generate` after changing a schema.

Set `PHARMACART_DB_PASSWORD` in `infra/.env` to a generated local password. Run `npm run db:up` to start the separate `pharmacart` Compose project on localhost port 55432; `npm run db:status` shows its health and `npm run db:stop` stops it without deleting data. The pinned PostgreSQL image must already exist locally (`pull_policy: never`).

Run `npm run db:migrate` for the local development schema and `npm run test:integration` for real PostgreSQL isolation and migration tests. Integration tests create and reset only the dedicated `pharmacart_test` database inside this Compose project. They must not be pointed at customer data.

The bootstrap account is used only by local administration and test scripts. The migrations define a separate non-login, non-owner runtime role with forced RLS. A future authenticated API must validate membership and branch access before setting transaction-local context; the SQL context itself is not authentication.

## Status

B0/B1 foundations are in progress. Schema-derived contracts, synthetic fixtures, pack matching, immutable snapshot processing, SQL migrations and tenant-isolation tests exist. AC-001 through AC-018 remain NOT RUN as full acceptance gates: partial domain and SQL coverage does not prove an authenticated end-to-end application.

API, OIDC, durable feed ingestion, quotes/budgets, worker dispatch, client applications and vendor integrations remain unimplemented. No `dev`, application `build` or E2E command exists yet. See [current status](docs/STATUS.md) and [local database recovery](docs/LOCAL-DATABASE-RUNBOOK.md).

See [build ownership](docs/BUILD-OWNERSHIP.md), [contracts](docs/contracts-foundation.md), and [acceptance plan](docs/acceptance-plan.md).
