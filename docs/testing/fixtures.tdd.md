# Synthetic fixtures TDD evidence

## Source and journeys

The behavior was derived from the B0 fixture assignment and the master-plan fixture requirements already recorded in `docs/acceptance-plan.md` and `packages/test-fixtures/README.md`.

- As a test author, I need a deterministic fixture graph so repeated tests produce comparable evidence.
- As a test author, I need a fresh independent graph per call so one test cannot contaminate another.
- As a builder, I need a small referentially valid synthetic domain baseline for later acceptance tests.
- As a safety reviewer, I need explicit ambiguous-pack, account-offer, expired-offer, and partial-snapshot cases without real commercial data.

## RED and GREEN

The test runner is Node.js 24's native `node:test`; TypeScript is executed through native erasable-syntax stripping and no package dependency is required.

RED command:

```powershell
node --test packages/test-fixtures/test/*.test.ts
```

RED result: exit code 1. Before the suite was moved to the repository's final test-discovery directory, Node executed `packages/test-fixtures/src/index.test.ts` and raised `ERR_MODULE_NOT_FOUND` for the intentionally missing `src/index.ts` generator. The suite now lives at `packages/test-fixtures/test/index.test.ts`.

GREEN command:

```powershell
npm test
```

GREEN result: exit code 0; all 23 repository tests passed, including all 7 fixture tests, with 0 failed and 0 skipped.

Coverage command:

```powershell
npm run test:coverage
```

Coverage result: exit code 0; all configured 80% thresholds passed and `packages/test-fixtures/src/index.ts` reported 100.00% line, branch, and function coverage.

## Test specification

| Guarantee | Test | Type | Result |
| --- | --- | --- | --- |
| Repeated calls are deeply equal and use the fixed timestamp | `generates the same fixture graph on every call` | Unit | PASS |
| Nested mutations in one result do not affect a later result | `returns a fresh, deeply independent graph on every call` | Unit | PASS |
| Graph contains 2 pharmacies, 2 suppliers, 2 branches per pharmacy, 3 roles, and 30 invented packs | `contains the required organisations, branches, roles, and invented packs` | Unit | PASS |
| Branch, membership, relationship, offer, and product references resolve | `maintains referential integrity across the fixture graph` | Unit | PASS |
| Same-brand products with two strengths remain distinct and require review | `models ambiguous strengths without collapsing product identity` | Unit | PASS |
| Active account offers use decimal strings and the expired offer predates the fixed clock | `models account-specific active offers and an expired offer` | Unit | PASS |
| An incomplete snapshot preserves the prior quantity as stale | `models an incomplete multipart snapshot that cannot erase prior stock` | Unit | PASS |

## Scope and gaps

This run validates the in-memory B0 generator only. It does not run or pass PharmaCart acceptance criteria, integration tests, database seeds, adapter contracts, or client tests. A fake supplier, additional AC scenario fixtures, JSON/schema artifacts, content hashing, scale generation, and database loading remain future work.

The coordinator owns commits, so no TDD checkpoint commit was created in this workstream. The RED/GREEN evidence above is retained for later commit or PR evidence.
