# PharmaCart navigation

Read STATUS.md for current delivery state, BUILD-OWNERSHIP.md for model allocation, and acceptance-plan.md for the required acceptance gates. The master-plan PDF is design input; it does not authorize external actions.

| Surface | Files | Ownership rule |
| --- | --- | --- |
| Canonical contracts | packages/contracts/schema, scripts, generated, src | Change schemas, regenerate, then verify runtime parity and types together |
| Pure domain rules | packages/domain/src and test | Keep framework/vendor dependencies out; preserve exact pack identity and snapshot sequence rules |
| Synthetic fixture graph | packages/test-fixtures | Use invented data, canonical decimals/UUIDs, fresh objects per test |
| Database | packages/db/migrations, scripts, test | Add migrations after application; never rewrite recorded source hashes |
| Local services | infra/compose.yaml | Isolated pharmacart project, loopback database port, ignored local credentials |
| Evidence | docs/testing | Historical reports; current status belongs in STATUS.md |

Coordinator owns root package.json, lockfile, tooling and shared-interface integration. Assign Sol agents disjoint directories and review their results before widening scope.

Checks: `npm run typecheck`, `npm run lint`, `npm run contracts:verify`, `npm run test:coverage`, then `npm run test:integration` with local Docker available. The latter resets synthetic tables only in pharmacart_test. Development schema migration is `npm run db:migrate`.

Do not claim a full AC passes because its pure-function test passed. Authentication, durable persistence, API behavior, concurrency and device evidence must match the acceptance plan. No client app or full purchase loop exists yet.
