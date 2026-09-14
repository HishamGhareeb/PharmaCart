# List and mapping API registration with OpenAPI contracts

Date: 2026-09-14. Branch `claude/api-registration-openapi`, base `cd4bb7e`. Synthetic data only.

Closes the integration half of the STATUS.md item "tenant-list and explicit human mapping modules ...
unregistered pending OpenAPI integration and final role-policy review". The role-policy review stays open
and is a human decision; see section 3. **No acceptance criterion moves.** No database or OIDC test was run
in this lane; section 5 lists what the coordinator must run.

## 1. What changed

| File | Change |
| --- | --- |
| `apps/api/src/request-auth.ts` (new) | `TokenVerifier`, `authenticate`, `selector`, `TenantScope` and `poolScope`, moved out of `tenant-api.ts` so route modules registered by `buildTenantApi` do not import it back (a runtime cycle) and `mapping-routes.ts` no longer keeps a private copy |
| `apps/api/src/tenant-api.ts` | Registers `registerListRoutes` and `registerMappingRoutes`; re-exports `authenticate`, `selector`, `TokenVerifier` for existing importers |
| `apps/api/src/list-routes.ts` | Uses the shared `poolScope`; adds the list role check (section 3) |
| `apps/api/src/mapping-routes.ts` | Uses the shared `poolScope`; accepts an optional injected `scope` like the list module; body schema now imported from the OpenAPI source |
| `packages/contracts/scripts/openapi.ts` | Four operations, `NeedPage`, `OrderPage`, `MappingCandidates`, `MappingResult`, exported `mappingCommandSchema`, list query parameters; `TenantContext.role` description extended |
| `packages/contracts/openapi.json` | Regenerated. Every pre-existing path and schema is byte-identical except the `TenantContext.role` description. `generated/contracts.ts` is unchanged |
| `packages/db/test/lists.test.ts`, `mapping.test.ts` | Helpers no longer register the module on top of `buildTenantApi`. Required: Fastify refuses a duplicate route (`FST_ERR_DUPLICATED_ROUTE`), so both suites would fail at setup otherwise. **Outside the enumerated file scope; flagged for the coordinator** |
| `packages/db/test/openapi-registered-live.test.ts` (new) | Live PostgreSQL + OIDC contract test for the four routes. **Outside the enumerated file scope; flagged** |
| `apps/api/test/*` | See section 4 |

## 2. Registered routes

All four run through `poolScope`: bearer verification, canonical UUID selectors, then `withTransaction`,
which resolves active membership and branch for every request before any row is read. A malformed selector
never takes a connection (asserted with a counting pool).

| Method and path | operationId | Required principal | Success | Errors produced |
| --- | --- | --- | --- | --- |
| `GET /v1/needs` | `listNeeds` | pharmacy org; `pharmacy_owner` or `purchaser` (**open decision**) | 200 `NeedPage` | 400 `INVALID_REQUEST`, 400 `INVALID_CURSOR`, 401, 403, 500 |
| `GET /v1/orders` | `listOrders` | pharmacy org; `pharmacy_owner` or `purchaser` (**open decision**) | 200 `OrderPage` | 400 `INVALID_REQUEST`, 400 `INVALID_CURSOR`, 401, 403, 500 |
| `GET /v1/needs/{id}/mapping-candidates` | `getMappingCandidates` | pharmacy org; `pharmacy_owner` or `purchaser` (repository rule, unchanged) | 200 `MappingCandidates` | 400, 401, 403, 404, 409 `AMBIGUOUS_NEED_UNIT`, 500 |
| `POST /v1/needs/{id}/mapping` | `bindNeedMapping` | pharmacy org; `pharmacy_owner` only (repository rule, unchanged) | 201 new decision, 200 idempotent repeat, both `MappingResult` | 400, 401, 403, 404, 409 (`NEED_VERSION_CONFLICT`, `NEED_NOT_OPEN`, `AMBIGUOUS_NEED_UNIT`, `MAPPING_DECISION_CONFLICT`), 422 (`CATALOGUE_UNVERIFIED`, `CATALOGUE_IDENTITY_INCOMPLETE`, `SUPPLIED_UNIT_REQUIRED`, `UNIT_MISMATCH`), 500 |

Every operation documents the project's uniform set `400, 401, 403, 404, 409, 413, 422, 500` with
`ErrorEnvelope`, as the existing operations do. 413 cannot occur on the GET routes and 404/409/422 cannot
occur on the lists; that is the existing convention, not new. 415 is still emitted by the shared handler
for a non-JSON POST and still not enumerated (pre-existing gap recorded in `openapi-responses.md`).

Every refusal uses the existing envelope and fixed messages. A role or organisation-kind refusal on a list
is word for word the denied-membership refusal. A need hidden by row level security is 404, identical to an
absent one.

## 3. Role policy

- **Mapping:** enforced exactly as `assertMappingReadAllowed` / `assertMappingWriteAllowed` and their tests
  encode. Not ambiguous.
- **Lists: OPEN DECISION for human review.** `lists.ts` explicitly leaves the in-pharmacy role undecided and
  enforces only the organisation kind. The reviewed PostgreSQL evidence (`packages/db/test/lists.test.ts`)
  lists as `pharmacy_owner` (user a) and as `purchaser` (user b in B), so both are admitted; changing that
  would contradict passing evidence. Nothing encodes `receiver` or `support`, so the route now refuses them
  (`LIST_ROLES` in `list-routes.ts`). This is the most restrictive existing role set consistent with the
  evidence, and it is the quote and mapping-read set. Before this lane any active pharmacy member could list.
  Questions for the reviewer: should a `receiver` see order summaries (it may confirm receipts on
  `/v1/orders/{id}/receipts`)? Should `support` see either list?

## 4. Tests

Written before the implementation. RED, same five files, before any source change:

```
node --experimental-strip-types --test apps/api/test/list-routes.test.ts apps/api/test/mapping-routes.test.ts apps/api/test/response-contracts.test.ts apps/api/test/tenant-registration.test.ts packages/contracts/test/openapi-responses.test.ts
ℹ tests 69 | pass 54 | fail 15
```

Failure reasons were the intended ones: receiver/support were served a list (200); the mapping `scope`
option was ignored, so injected-scope cases hit authentication (401); `GET /v1/needs` missing from the
document and not registered; re-registering did not throw; `packages/contracts/test/openapi-responses.test.ts`
failed to load because `mappingCommandSchema` was not exported (a whole-file RED, counted as one failure).

GREEN after implementation and `npm run contracts:generate`: `ℹ tests 89 | pass 89 | fail 0`.
All of `apps/api/test/*.test.ts` and `packages/contracts/test/*.test.ts`: `ℹ tests 126 | pass 126 | fail 0`
(103 before this lane).

| Test | Needs DB/OIDC | What it proves |
| --- | --- | --- |
| `packages/contracts/test/openapi-responses.test.ts` (extended) | no | The four operations exist with concrete success schemas, uniform error set, scope headers, exact query parameters (status enums re-derived from migrations), mapping body equals the route schema, role stated per operation; accept/reject cases for the four new schemas, including leaked tenant ids, counts, prices, numeric quantities |
| `apps/api/test/response-contracts.test.ts` (extended) | no | Real Fastify responses validated against the schema the document lists for that operation *and status*: anonymous 401 for every tenant read on `buildTenantApi`; list pages built by the real `listNeeds`/`listOrders` mapping over synthetic rows; every list refusal; mapping 200/201/200-repeat and every mapping refusal from the real repository over a scripted client; documented bounds equal `MAX_LIMIT`, `MAX_CURSOR_LENGTH`, `MAX_SALE_UNIT_LENGTH`, `MAX_MAPPING_CANDIDATES` |
| `apps/api/test/tenant-registration.test.ts` (new) | no | `buildTenantApi` serves exactly the documented operations (route tree vs document, both directions); duplicate registration is refused; authentication then selector validation happen before any connection |
| `apps/api/test/list-routes.test.ts` (extended) | no | owner and purchaser may list; receiver and support are refused before a cursor is judged or a row read |
| `apps/api/test/mapping-routes.test.ts` (extended) | no | injected-scope behaviour: candidates for owner and purchaser, 201 and 200 bind outcomes, every refusal's exact envelope, membership denial and redacted 500, malformed path id before any statement |
| `apps/api/test/mapping-fixture.ts` (new, helper) | no | scripted client answering `mapping.ts` statements; no SQL runs, so it proves shapes, not SQL validity |
| `packages/db/test/openapi-registered-live.test.ts` (new) | **yes** | Over `buildTenantApi` unchanged: keyset need walk, purchaser isolation, cross-tenant cursor refused like a malformed one, empty then queued order page after a real approval, receiver refused on all four routes, list boundary refusals, candidates for owner and purchaser, foreign need 404 identical to absent, eight bind refusals with no decision recorded, 201 then 200 repeat, the decision visible through both reads. Every body is validated against the document and checked for the other tenant's identifiers |
| `packages/db/test/lists.test.ts`, `mapping.test.ts` (helpers edited) | **yes** | Unchanged assertions, now against the registered route tree |

## 5. Coordinator commands (not run here)

```
node --experimental-strip-types --test packages/db/test/openapi-registered-live.test.ts
node --experimental-strip-types --test packages/db/test/lists.test.ts
node --experimental-strip-types --test packages/db/test/mapping.test.ts
node --experimental-strip-types --test packages/db/test/openapi-live.test.ts
npm run test:integration
npm run test:coverage
```

`openapi-live.test.ts` is unchanged but builds `buildTenantApi`, which now registers more routes. Expected
live assumptions still unconfirmed here: need A reads back `quantity: '2'`; a full approval of need A leaves
it `covered` at version 2 (the basis of the `NEED_NOT_OPEN` case); a new order intent reads `version: 1`;
the two seeded catalogue packs are the only eligible candidates for an unmapped need without unit metadata.

## 6. Observations, not changed

- `packages/db/src/mapping.ts` types `MappingRecord.decisionId` as `string | null`, but both return paths
  set a string. The contract documents it as a required UUID; the live test will catch any divergence. Not
  a defect today.
- No defect was found in `packages/db/src`.

## Coordinator verification

Run by the coordinator, the single database and OIDC test runner, on this worktree at base `cd4bb7e`. The builder ran the suites that need neither and was barred from the rest.

RED at the real boundary. With the two registration calls removed from `buildTenantApi` and then restored exactly:

```
$ node --experimental-strip-types --test --test-concurrency=1 packages/db/test/openapi-registered-live.test.ts
404 !== 200
tests 1, pass 0, fail 1
```

GREEN:

| Command | Needs | Tests | Pass | Fail |
| --- | --- | --- | --- | --- |
| `packages/db/test/openapi-registered-live.test.ts` | PostgreSQL, OIDC | 1 | 1 | 0 |
| `packages/db/test/lists.test.ts` | PostgreSQL, OIDC | 3 | 3 | 0 |
| `packages/db/test/mapping.test.ts` | PostgreSQL, OIDC | 4 | 4 | 0 |
| `packages/db/test/openapi-live.test.ts` | PostgreSQL, OIDC | 1 | 1 | 0 |
| `apps/api/test/*.test.ts packages/contracts/test/*.test.ts` | none | 126 | 126 | 0 |
| `npm run typecheck`, `npm run lint`, `npm run contracts:verify` | | | pass | |

The live test passing confirms the three facts the builder could not check without a database: a full approval leaves the need covered at version 2, a new order intent reads back as version 1, and the two seeded catalogue packs are the only candidates for an unmapped need.

## Coordinator review notes

**The authentication move adds no authorization gap.** `authenticate` and `selector` in `request-auth.ts` are byte-for-byte the code removed from `tenant-api.ts`. The new `poolScope` authenticates, validates both tenant headers, then calls `withTransaction`, which looks up active membership and branch authority before setting context and again after. The base `tenant-api.ts` called `withTransaction` with exactly those arguments, so this is the existing reviewed pattern in one place.

**The edits under `packages/db/test` are accepted.** Once `buildTenantApi` registers the list and mapping routes, the helpers that also registered them caused a duplicate-route error at setup. Removing that line changed no assertion.

**List access was tightened and is an open human decision.** Before this change any active pharmacy member could list needs and orders, because no role was checked. Now only `pharmacy_owner` and `purchaser` may; `receiver` and `support` are refused. It is kept because it is the least-privileged set consistent with the passing evidence, and no client yet calls the list routes, so nothing regresses. Whether a receiver should see order summaries, and whether support should see either list, remain for the product owner.
