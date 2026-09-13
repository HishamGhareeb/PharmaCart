# Concrete OpenAPI success response contracts

Branch `claude/openapi-responses`, base `9584ace`. Scope: replace the generic `{"type":"object"}` success
schema in the generated document with concrete contracts read off the current handlers, and lock them with
regression tests. No route, domain or database behaviour was changed; no migration, package.json or
lockfile was touched.

Owned files: `packages/contracts/scripts/openapi.ts`, generated `packages/contracts/openapi.json`,
`packages/contracts/test/openapi-responses.test.ts`, `apps/api/test/response-contracts.test.ts`,
`packages/db/test/openapi-live.test.ts` and this document.

Three layers of evidence, deliberately kept distinguishable:

| Layer | File | What it proves |
| --- | --- | --- |
| Schema and preservation | `packages/contracts/test/openapi-responses.test.ts` | the document is concrete, strict and internally consistent; hand written examples and mutations, clearly banner-marked as **not** captured responses |
| Real pure responses | `apps/api/test/response-contracts.test.ts` | the two endpoints `buildApp` serves without a database, and the negative surface |
| Real tenant responses | `packages/db/test/openapi-live.test.ts` | live PostgreSQL and live OIDC responses validated against the generated schemas — **not run in this lane** |

## Where each shape was read from

| Contract | Source of truth | Status codes |
| --- | --- | --- |
| `HealthStatus` | `apps/api/src/app.ts` handler returns `{status:'ok'}` | 200 |
| `OpenapiDocument` | `renderOpenapi()` output served verbatim by `app.ts` | 200 |
| `TenantContext` | `TenantContext` built in `packages/db/src/runtime.ts` and returned unchanged by `/v1/context` | 200 |
| `NeedView` | need `SELECT` projection in `apps/api/src/tenant-api.ts` | 200 |
| `InventoryAcceptance` | `ingestInventory` return value in `packages/db/src/inventory.ts` | 202 |
| `Quote` | `createQuote` return value in `packages/db/src/procurement.ts` | 201 |
| `ApprovalResult` | `approveQuote` `body` in `packages/db/src/procurement.ts`, replayed from `command_result` | 200 and 202 |
| `OrderDetail` | order intent and order line `SELECT` plus the `uncertainty` branch in `tenant-api.ts` | 200 |
| `ReceiptAcknowledgement` | `confirmReceipt` return value in `packages/db/src/orders.ts` | 200 |

Column types, check constraints and enumerations were read from the twelve applied migrations. The
contracts test re-derives the role, organisation kind, need status and order state enumerations from the
migration text at run time, so a future constraint change cannot silently diverge from the document.

## Decisions that keep the schemas honest

- **Two different decimal formats.** Commercial amounts (`Quote.total`, line `gross/discount/tax/fees/net`)
  pass through `canonical()`, which strips trailing fractional zeros, so they use a canonical pattern.
  Quantities read back from `numeric` columns (`NeedView.quantity`, every order line quantity) are rendered
  with `::text`, which preserves the stored scale: `received` is `received + quantity`, and numeric addition
  takes the widest scale of its operands, so `'1.0'` and `'7.500'` are valid readings. Those fields use a
  looser pattern that still refuses signs, exponents, leading zeros and non-strings. Imposing the canonical
  pattern there would have been stricter than valid persistence.
- **The error code is not an enumeration.** `/v1/inventory` maps `InventoryError` straight onto the envelope,
  and the domain rejection reasons are lower case (`stale_sequence`, `conflicting_partition`,
  `conflicting_snapshot`, `invalid_event`, `duplicate_source_row`). The envelope therefore stays strict
  (`additionalProperties:false`, all three members required, UUID correlation id) with an extensible
  `^[A-Za-z][A-Za-z0-9_]*$` code rather than an upper case enum.
- **`unmetLines` is documented as always empty** (`maxItems: 0`). The current API refuses the whole quote
  with 422 (`NO_BINDING_OFFER`, `MAPPING_UNVERIFIED`, `QUANTITY_EXCEEDS_NEED`, `UNIT_MISMATCH`) instead of
  returning partially met demand. The schema records the refusal behaviour instead of implying a feature.
- **`OrderDetail.lines` has no minimum.** Lines are materialised by the worker when it claims the intent, so
  a queued intent legitimately returns `[]`. `externalOrderId` is nullable until an acknowledgement lands,
  and `uncertainty` is a nullable object whose only shape is `{safeToRetry:false,nextAction:'reconciliation_required'}`.
- **`productIdentity` stays open.** It is an opaque catalogue snapshot; only `saleUnit` is contractual
  (the quote path refuses a line whose unit differs), so unknown catalogue attributes are allowed there while
  every response envelope around it refuses unknown fields.
- **`pricingRuleVersion` is `synthetic-cash-tax-exempt-v1`**, described in the document as a fixture
  identifier: discount, tax and fees are always `'0'` and no mapping administration or supplier selection
  policy is applied. The money fields keep the canonical pattern rather than a `'0'` constant so that the
  commercial policy lane can change the rule without the schema lying in either direction.
- **Role and tenant scope are documented where the API provides them.** `/v1/context`, `/v1/needs/{id}`,
  `/v1/quotes`, `/v1/quotes/{id}/approve`, `/v1/orders/{id}` and `/v1/orders/{id}/receipts` keep the two
  required scope headers. `/v1/inventory` deliberately has none: its installation, organisation and branch
  derive from the verified token subject. `TenantContext` documents that quoting and approval require
  `pharmacy_owner` or `purchaser` and receipts require `pharmacy_owner` or `receiver`, and that
  `allowedBranchIds` is exactly the one requested branch.
- **Error responses now reference `components.schemas.ErrorEnvelope`** instead of repeating it 72 times.
  The component already existed and was unused; the envelope content is unchanged. `openapi.json` dropped
  from 2 823 to 876 lines while gaining nine concrete contracts.

Request bodies, `security`, `securitySchemes`, the scope and `Idempotency-Key` parameters, the path `id`
parameter and the `X-Correlation-Id` response header are asserted unchanged by
`packages/contracts/test/openapi-responses.test.ts`.

## Evidence

RED, before `openapi.ts` was changed:

```
node --experimental-strip-types --test packages/contracts/test/openapi-responses.test.ts apps/api/test/response-contracts.test.ts
ℹ tests 18
ℹ suites 2
ℹ pass 2
ℹ fail 16
```

The two passing tests are the preservation guards (request bodies, security, headers, error status set);
every test that asserts a concrete success contract failed against the generic `{"type":"object"}` schema.

GREEN, after `npm run contracts:generate`:

```
node --experimental-strip-types --test packages/contracts/test/openapi-responses.test.ts apps/api/test/response-contracts.test.ts
ℹ tests 18
ℹ suites 2
ℹ pass 18
ℹ fail 0
```

Whole non-database suite and static checks:

```
npm test                  ℹ tests 349  ℹ suites 57  ℹ pass 349  ℹ fail 0
npm run typecheck         clean
npm run lint              clean
npm run contracts:verify  contracts verified
```

`npm test` is the non-database suite; the 18 new tests are included in the 349. Typecheck and lint were
re-run after `packages/db/test/openapi-live.test.ts` was added and stayed clean. Database suites,
`npm run test:coverage`, `npm run test:integration`, migrations and Docker were not run: the coordinator
serialises shared `pharmacart_test` work.

One pure probe was run to fix the expected supplier split before writing the live assertions, because
`FakeSupplier` is file-backed and needs no database:

```
FakeSupplier('partial' split of ordered 1.5) -> accepted '0.5', rejected '1', shipped '0.5'
```

## Awaiting coordinator verification

`apps/api/test/response-contracts.test.ts` validates only responses a real server produced, and `buildApp`
serves just `/health` and `/openapi.json` without a database. It also asserts the negative surface: every
tenant path documented in the generated document is unreachable on `buildApp` and answers with the
documented error envelope, which keeps the served surface and the document consistent.

The examples in `packages/contracts/test/openapi-responses.test.ts` are **hand written**, grounded in the
fixture graph in `packages/db/test` (organisation `1000…01`, branch `2000…01`, need `4000…01` `SYN-A`
quantity `2`, offer `12.35` EGP, partial acknowledgement of 1 accepted and 1 rejected). They are
banner-marked in that file as examples, not captured responses, and they are not evidence that the live API
matches the schema.

`packages/db/test/openapi-live.test.ts` supplies that evidence and is **written but not executed here**. It
is a single serial test that resets `pharmacart_test`, seeds the procurement and installation fixtures,
mints a real token from the local OIDC provider and validates every body the server returns against the
schema the same server publishes at `/openapi.json`:

| Contract | Live case |
| --- | --- |
| `TenantContext` | member scope for `synthetic:user:a`, asserted field by field (`pharmacy_owner`, one allowed branch) |
| `NeedView` | open need `'2'`, then the `'0.5'` remainder left open at version 2 by a partial approval |
| `InventoryAcceptance` | fresh partition, byte-identical replay (`duplicate:true`, same revision), and the completing event that publishes a new revision |
| `Quote` | 1.5 boxes at 12.35 EGP: total `'18.53'` cross-checked against `quote.total::text`, zero discount/tax/fees, UTC expiry, empty `unmetLines` |
| `ApprovalResult` | 202 first approval and the 200 replay of the same idempotency key, asserted deep-equal |
| `OrderDetail` | `queued` with no materialised lines and a null external order, `outcome_unknown` with the uncertainty object, and `acknowledged` with the `0.5`/`1`/`0.5` supplier split |
| `ReceiptAcknowledgement` | first receipt, identical replay returning the same identity, and a second receipt with a different reference |
| `ErrorEnvelope` | live 401, 403, 404 and a 409 `RECEIPT_EXCEEDS_SHIPPED`, including the correlation id echo |

Mixed decimal scales are the point of the fractional quantity: two receipts of `0.25` read back as `'0.50'`
against a shipped `'0.5'`. The test asserts both readings and then asserts, using the patterns taken from
the generated document itself, that the stored-quantity pattern accepts `'0.50'` while the canonical money
pattern refuses it. That is the concrete regression this document's two decimal formats exist for.

Before writing those assertions, the supplier split was fixed by running `FakeSupplier` directly, since it
is file-backed and needs no database; the arithmetic assumptions that remain unconfirmed here are
PostgreSQL's, namely `round(12.35*1.5,2) = 18.53`, the `2 - 1.5 = 0.5` remainder and the `0.25 + 0.25 =
0.50` scale rule.

No acceptance criterion moves on this work. AC-001 to AC-018 stay NOT RUN, and the live test verifies
documentation conformance only.

## Observation for the coordinator, not changed here

`installErrorHandlers` can emit 415 `UNSUPPORTED_MEDIA_TYPE`, but 415 is not enumerated in the response set
(`400, 401, 403, 404, 409, 413, 422, 500`). The API test asserts the real 415 body still satisfies
`ErrorEnvelope` and records the gap; adding the status to the document is a documentation decision outside
this task's "replace generic success objects" scope.

## Coordinator integration verification

The coordinator reproduced RED on the runtime branch: 18 tests, 1 pass, 17 failures (checkpoint 7d095e6). After applying the reviewed schema renderer, all 18 passed. The builder counts above are historical worktree evidence.

The new live PostgreSQL test initially failed because it expected 200 for same-key approval replay. Runtime correctly preserves the original 202 status and body. The test and description now distinguish this from a new key against an already approved quote, which returns 200. Both cases are exercised. The corrected live test passed against authenticated API responses, including stored received quantity 0.50. Raw evidence is in ignored tmp/openapi-live-green.txt (failed assumption) and tmp/openapi-live-recheck.txt (pass).

Typecheck, lint, generated-contract verification and build passed. Full combined coverage passed: 384 tests, zero failures (353 unit/contract/policy and 31 PostgreSQL). Coverage: 96.56% lines, 89.56% branches, 96.45% functions; process exit 0. Output retained in docs/testing/openapi-integrated-coverage.txt with trailing whitespace trimmed; original raw output remains in ignored tmp/openapi-integrated-coverage.txt. No acceptance criterion moves.
