# PharmaCart

Local synthetic procurement loop. See [current status](docs/STATUS.md) for implemented behavior and acceptance gaps.

## Development

Use Node 24.19.0 and npm 11.17.0. Run `npm ci`. Set `PHARMACART_DB_PASSWORD` in ignored `infra/.env` to a generated local password, then run `npm run setup`. This starts the isolated pharmacart Docker Compose project, applies migrations, configures a restricted runtime login and seeds invented data. The pinned PostgreSQL image must exist locally.

Run `npm run dev` for the API and local OIDC provider. API: http://127.0.0.1:3000; OpenAPI: `/openapi.json`; OIDC: http://127.0.0.1:55433. Run `npm run build` and `npm start` for the compiled API. Runtime credentials live in ignored `infra/runtime.env`; bootstrap credentials are not used by API requests.

`npm run worker:once` performs synthetic reconciliation. Explicit `npm run worker:once -- --submit` enables fake-supplier dispatch after reconciliation. The fake supplier persists its independent ledger under ignored tmp storage. No real supplier is contacted.

## Verification

Run `npm run typecheck`, `npm run lint`, `npm run contracts:verify`, `npm run test:coverage`, and `npm run test:integration`. Coverage includes database tests and requires Docker. Integration tests reset only the disposable pharmacart_test database; run them serially. `npm run verify` also builds the application. Regenerate contracts and OpenAPI with `npm run contracts:generate`.

`npm run db:status` checks local services; `npm run db:stop` stops them without deleting data. See [database recovery](docs/LOCAL-DATABASE-RUNBOOK.md), [build ownership](docs/BUILD-OWNERSHIP.md), [contracts](docs/contracts-foundation.md), and [acceptance plan](docs/acceptance-plan.md).

All AC-001 through AC-018 remain NOT RUN as full gates. Client applications and real supplier integrations remain unbuilt.
