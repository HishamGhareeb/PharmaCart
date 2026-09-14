# Tenant-scoped list and read APIs

Date: 2026-09-13. Branch `claude/tenant-list-api`, isolated worktree, synthetic data only.

Scope, all new files, nothing pre-existing edited:

- `packages/db/src/lists.ts`
- `packages/db/test/lists.test.ts`
- `apps/api/src/list-routes.ts`
- `apps/api/test/list-routes.test.ts`
- this report

No migration, no change to `apps/api/src/tenant-api.ts`, no OpenAPI regeneration, no `package.json`
or lockfile edit, no new dependency. **No acceptance criterion moves to PASS from this work.**
AC-001 through AC-018 remain NOT RUN. The database suite was **not executed here**; see section 5.3.

This report covers two passes over the same five files: the original build, and a **review pass**
that found and fixed three defects in it — an unauthenticated cursor oracle, a fabricated
`outstandingQuantity`, and a missing pharmacy-side principal gate. Section 5.2 is the review pass;
section 5.2b is the original build, kept because its record is still the evidence for everything the
review pass did not touch.

## 1. What was built

`GET /v1/needs` and `GET /v1/orders`, both tenant-scoped, both paginated, so the web flow no longer
has to be handed every resource UUID by hand.

| Layer | File | Responsibility |
| --- | --- | --- |
| Repository | `packages/db/src/lists.ts` | Query validation, cursor codec, row mapping, two parameterised statements |
| Route | `apps/api/src/list-routes.ts` | `registerListRoutes(app, pool, verifier)`, schema, error mapping |

Response shape, identical for both resources:

```json
{ "items": [ ... ], "nextCursor": "<opaque token>" | null }
```

A need item:

```json
{ "id": "...", "productRef": "SYN-A", "quantity": "2.500", "outstandingQuantity": "2.500" | "0" | null,
  "status": "open", "version": 3,
  "mappingStatus": "verified" | "unverified" | "unmapped",
  "productId": "<uuid>" | null, "saleUnit": "box" | null }
```

An order item:

```json
{ "id": "...", "state": "queued", "version": 1,
  "externalClientRef": "pc-syn-...", "externalOrderId": null,
  "lines": { "total": 0, "settled": 0, "awaitingReceipt": 0 },
  "uncertainty": null | { "safeToRetry": false, "nextAction": "reconciliation_required" } }
```

### 1.1 Coordinator registration hook

The module registers nothing by itself. After review, integration is one import and one call in
`buildTenantApi`, immediately before `return app;`:

```ts
import { registerListRoutes } from './list-routes.ts';
// ...
  registerListRoutes(app, pool, verifier);
  return app;
```

`packages/db/test/lists.test.ts` performs exactly this in its own `buildListApi` helper, so the
integration run exercises the same wiring integration will use.

Both test files are picked up by the existing globs with no script change: `apps/api/test/*.test.ts`
is in `npm test` and `npm run test:coverage`; `packages/db/test/*.test.ts` is in
`npm run test:integration` and `npm run test:coverage`.

## 2. Security and scope decisions

### 2.1 Row level security is the only tenant predicate

Neither statement contains an `organisation_id` or `branch_id` filter. Visibility comes entirely from
`need_tenant_branch_policy` and the `tenant_scope` policies, which read
`app.organisation_id`/`app.branch_id` established by `withTransaction`. A hand-written predicate
would have masked a policy regression instead of surfacing it.

Two checks hold that line:

- `apps/api/test/list-routes.test.ts` asserts the statement text contains neither identifier.
- `packages/db/test/lists.test.ts` opens a transaction, runs `SET LOCAL ROLE pharmacart_runtime`,
  deliberately sets **no** GUC, calls `listNeeds`/`listOrders` and asserts zero rows; it then sets
  the GUCs for organisation B and asserts the same statement returns only B's row.

`procurement_product` is the one joined table without RLS. It is a global catalogue, already granted
to `pharmacart_runtime` and already read by `createQuote`. It is only ever reached through
`source_product_map`, which is tenant-scoped, so a row of it is only observable via a mapping the
caller's own branch owns.

### 2.2 Query contract

`limit`, `status`, `cursor`. Nothing else: the Fastify schema sets `additionalProperties: false`, so
an unknown key, a repeated key (which arrives as an array) or an oversized value is refused before
the handler runs.

- `limit`: `^[1-9][0-9]{0,2}$` then `1 <= n <= 100`, default 25. Leading zeros, signs, decimals,
  exponents, whitespace and non-ASCII digits are all refused.
- `status`: allowlist membership only, per resource. `needs` accepts `open|quoted|covered|closed`;
  `orders` accepts `queued|submitting|outcome_unknown|acknowledged|rejected|human_review`. The
  vocabularies do not cross over. The value is bound as `$1` and compared with `=`; it never reaches
  the statement text, so the allowlist is defence in depth rather than the only barrier. A test calls
  the repository directly with `open'; DROP TABLE need;--` as a status and asserts it travels as a
  parameter and that the statement text is unchanged.
- No sort, order, field-selection or filter-identifier parameter exists at all.

### 2.3 Opaque keyset cursor

`base64url(JSON({ v, s, a }))` where `a` is the last returned id and `s` is a truncated SHA-256 of
`[version, resource, organisationId, branchId, status]`.

Ordering is `ORDER BY <table>.id` with `id > $2::uuid` — a keyset, never an `OFFSET` — so a page
boundary cannot skip or duplicate a row of unchanged data. One extra row (`LIMIT $3` with
`limit + 1`) is read to decide whether a further page exists, which avoids emitting any count.

The fingerprint is a digest, not a signature. The cursor is opaque **by contract, not confidential**:
it carries only the id the client already received, and no tenant selector in plain text. Its job is
to make a cursor from one scope, resource or filter unusable in another so pagination cannot be
steered. Forging one gains nothing, because visibility is still decided by row level security.

Decoding refuses anything that is not the exact issued shape: non-base64url characters, padding, a
non-canonical re-encoding, non-JSON, a non-object, a missing or extra key, an unknown version, a
non-canonical or non-lowercase uuid, or a fingerprint mismatch. **Every refusal is the same
`400 INVALID_CURSOR` with the same fixed message**, so a foreign-scope cursor is indistinguishable
from a malformed one and cannot be used as an existence oracle. Both test files assert that the two
responses are byte-identical apart from the correlation id.

Binding happens **once**, inside the transaction, against the membership the database actually
resolved — never against a request header. A test injects a scope that resolves a different branch
than the headers name and asserts the cursor is refused and the repository is never called.

An earlier revision also pre-checked the cursor *before* the transaction, against the scope the
caller claimed in its headers, to save a connection on an obviously foreign cursor. That was removed
in this pass because it inverted the authentication order: it ran before `authenticate`, so an
**anonymous** caller with any two canonical uuid headers could distinguish a cursor bound to that
scope (which fell through to `401`) from one that was not (`400 INVALID_CURSOR`) — an unauthenticated
oracle over the fingerprint, for a saving of one connection. See section 5.2, defect 1. Nothing
outside the transaction now looks at the cursor at all; `parseListQuery` is purely syntactic.

### 2.4 What each resource does and does not disclose

Needs. `productId` and `saleUnit` are reported **only** when the tenant's `source_product_map` is
`verified` *and* the `procurement_product` it points at is `verified`. Both the statement and
`toNeedSummary` apply that gate, so a row that slipped past one is still caught by the other.
`saleUnit` is the catalogue's `identity->>'saleUnit'` taken only when `jsonb_typeof(...) = 'string'`,
re-checked in TypeScript for a non-empty untrimmed string of at most 64 characters, and otherwise
`null`. Nothing is derived, converted or invented, and no offer, price or supplier is read at all.

`outstandingQuantity` follows the meaning recorded by `0012_procurement_invariants.sql`, and **only**
where that comment records one: `requested_quantity` while the need is `open`, `'0'` once it is
`covered` or `closed`, and `null` otherwise. The fourth status the CHECK in
`0001_identity_and_tenant_isolation.sql` permits, `quoted`, has no recorded reading and is written by
no code path today — `approveQuote` moves a need between `open` and `covered` only. An earlier
revision answered `'0'` there, which asserts to a pharmacist that there is nothing left to procure;
that is the same class of invention the sale unit rule refuses, so unknown is now reported as
unknown. See section 5.2, defect 2. `quantity` still reports the raw column unconditionally, so the
list agrees with `/v1/needs/:id`.

Quantities are `numeric::text` and are never parsed into a JavaScript number anywhere on the path. A
test round-trips `12345678901234567890.123456` and `0.000000000000000001` through the HTTP response.

Orders. The summary carries the state, version, the two external references already exposed by
`/v1/orders/:id`, the same `uncertainty` mapping, and **line counts**: `total`, `settled`,
`awaitingReceipt`. It deliberately does **not** sum quantities: the lines of one intent may carry
different sale units, so a single total would be a fabricated figure — the same rule that stops a
`saleUnit` being invented. Per-line quantities stay on `/v1/orders/:id`. The counterparty
(`supplier_id`), the `quote_id`, pricing and `submission_attempt.request_hash` are not selected at
all; a test asserts the statement text does not mention them.

### 2.5 A list is a pharmacy-side read

`requirePharmacyPrincipal` refuses any principal whose `organisationKind` is not `pharmacy`, with
`403 FORBIDDEN` and the message `"The selected scope is not permitted."` — word for word the refusal
a denied membership produces, so the two cannot be told apart. It runs in two places: at the route,
immediately inside the transaction and before the cursor is even looked at, and again as the first
line of `listNeeds`/`listOrders`, so a caller that reaches the repository directly is refused before
a statement timeout is set, let alone a `SELECT` issued.

This is not a new policy. It is the rule `createQuote`, `approveQuote` and `confirmReceipt` already
enforce on entry. An earlier revision omitted it and leaned on row level security returning no rows
for a supplier organisation — true today, but it is exactly the implicit reasoning this module
refuses everywhere else (it re-gates `productId` in TypeScript even though the statement gates it).
See section 5.2, defect 3.

Which *role* inside a pharmacy may list is a **separate and still undecided question** and was not
answered here; see limitation 5 in section 6.

### 2.6 Neither endpoint grants broader access than the individual routes

The database test compares a listed need field-by-field with `/v1/needs/:id` and asserts the only new
keys are `mappingStatus`, `outstandingQuantity`, `productId` and `saleUnit`; it does the same for an
order against `/v1/orders/:id`. Membership is resolved by the same `withTransaction`, so a revoked
membership loses the list exactly as it loses the individual route (asserted).

## 3. `GET /v1/scopes`: pending, deliberately not implemented

The task allowed it **only if** a narrow SECURITY DEFINER function turned out to be unnecessary. It
is necessary, so it was not built.

Enumerating a user's memberships means reading `membership`/`membership_branch` *before* an
organisation and branch are known. The existing helper cannot serve that:

```sql
pharmacart_active_membership(requested_subject text, requested_organisation_id uuid, requested_branch_id uuid)
```

It requires the very organisation and branch the caller is trying to discover. The RLS policies on
`membership` and `membership_branch` require `app.organisation_id`/`app.branch_id`, and
`withTransaction` cannot set them without those selectors either. The only ways to serve the endpoint
are a new SECURITY DEFINER function (a migration this lane does not own) or a broader membership
policy (a security regression). Neither was done, and **no migration was slipped into another lane**.

A test pins the decision: `GET /v1/scopes` returns 404 from this module.

Proposed shape for the coordinator, for review only — **not applied, not written to any migration
file**:

```sql
CREATE OR REPLACE FUNCTION pharmacart_available_scopes(requested_subject text)
RETURNS TABLE (organisation_id uuid, organisation_kind text, branch_id uuid, membership_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT member.organisation_id, organisation.kind, scope.branch_id, member.role
  FROM public.membership AS member
  JOIN public.organisation AS organisation ON organisation.id = member.organisation_id
  JOIN public.membership_branch AS scope
    ON scope.organisation_id = member.organisation_id AND scope.membership_id = member.id
  WHERE member.user_subject = requested_subject AND member.status = 'active'
$function$;
REVOKE ALL ON FUNCTION pharmacart_available_scopes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pharmacart_available_scopes(text) TO pharmacart_runtime;
```

It is narrow in the same way the existing function is: keyed on the authenticated subject, returning
only scope selectors and the caller's own role, no tenant payload. It still needs the coordinator's
review before any hash applies. **Until then the user interface must keep asking for explicit
scopes.**

## 4. Bounds, waits and privilege

- Every list is bounded: at most 100 items, cursor at most 512 characters, status at most 32.
- `requireBoundedQuery` re-checks the limit and the cursor id inside the repository, so a caller that
  bypassed the route cannot issue an unbounded statement. It throws before any statement is sent
  (asserted).
- The only wait a list page can incur is the statement itself: it is read-only, takes no row lock,
  holds no lease and never retries. It is capped server-side with
  `set_config('statement_timeout', '5000', true)`, transaction-local, so it reverts on commit or
  rollback and cannot leak into another request on a pooled connection. Because the bound is enforced
  by PostgreSQL rather than by a client-side deadline, **no wall-clock or monotonic reading is taken
  in the API process at all**, so there is no clock-skew or non-monotonic-timer hazard to get wrong.
- Privilege is unchanged: `SET LOCAL ROLE pharmacart_runtime` inside `withTransaction`,
  `statement_timeout` is a `USERSET` GUC, and no new grant, role or policy is introduced.
- Responses carry `cache-control: no-store`; this is authenticated per-tenant data.
- No development-only or synthetic component was added. The module has no fixture path, no seeded
  default and no environment switch, so there is nothing that could silently become a production
  default. `LIST_STATEMENT_TIMEOUT_MS` is a module constant, not configuration (see section 6).

## 5. Evidence

### 5.1 Commands actually run

```
npm run typecheck        -> tsc --noEmit, no output, exit 0
npm run lint             -> eslint ., no output, exit 0
npm run contracts:verify -> contracts verified
npm run build            -> Compiled application and OpenAPI assets ready in dist.
npm test                 -> tests 370 | pass 370 | fail 0   (non-database suites only)
```

`npm test` excludes `packages/db` entirely, so **nothing below was executed against PostgreSQL**;
see section 5.3. Composition: the new file alone was run and gives
`ℹ tests 39 | pass 39 | fail 0`; 370 − 39 = 331, which matches the 331 the original build measured by
actually running the reduced file list. The 331 is therefore corroborated arithmetic here, not a
fresh measurement — but it agrees, so no pre-existing test changed behaviour. (The earlier revision
of this report recorded 34 and 365; the five added cases are listed in section 5.2.)

Not run, and not runnable here: `npm run test:integration`, `npm run test:coverage`, `npm run db:up`,
`npm run db:migrate`, `npm run verify`. All of those need the `pharmacart_test` PostgreSQL instance.

### 5.2 RED then GREEN: the review pass

The first build of this lane is described in section 5.2b. This section records the **review pass**,
which found three defects in the reviewed modules. Each one got a failing test first, and each failed
for the reason claimed before any source line changed. One run produced all three:

```
$ node --experimental-strip-types --test apps/api/test/list-routes.test.ts
ℹ tests 39 | pass 35 | fail 4

✖ a status whose outstanding meaning the schema does not record reports null, not a fabricated zero
    actual: '0', expected: null
✖ a cursor is never inspected before the caller is authenticated
    actual: 400, expected: 401
    {"error":{"code":"INVALID_CURSOR","message":"The pagination cursor is not valid for this request."}}
✖ a non-pharmacy organisation is refused both list routes
    actual: 200, expected: 403
    {"items":[{"id":"40000000-...","productRef":"SYN-A",...}],"nextCursor":null}
✖ a non-pharmacy principal is refused inside the repository, not only at the route
    Missing expected rejection.
```

**Defect 1 — the cursor was judged before the caller was authenticated.** `list()` pre-checked the
cursor against the header-claimed scope outside the transaction, ahead of `authenticate`. An
anonymous request carrying any two canonical uuid headers therefore got `400 INVALID_CURSOR` when the
cursor did not belong to those headers and `401` when it did: an unauthenticated oracle over the
fingerprint. Fixed by deleting the pre-check and `claimedScope` entirely, which is the remedy the
earlier revision of section 2.3 had itself prescribed. Cost: a foreign cursor now spends a connection
and a membership lookup before refusal. That is the correct trade.

**Defect 2 — `outstandingQuantity` fabricated a zero for `quoted`.** The mapper answered `'0'` for
every status other than `open`, and this report cited `0012_procurement_invariants.sql` as the
authority. That comment records a reading for `open`, `covered` and `closed` only. Fixed with an
explicit `outstanding()` that returns `null` for any status whose meaning the schema does not record.

**Defect 3 — no principal gate at all.** Neither module read `organisationKind` or `role`. The RED
body above is the evidence: a `supplier` principal was served a pharmacy need. Row level security
does return nothing for a real supplier organisation today, so this was latent rather than live — but
it is the one procurement surface that relied on that instead of checking, and the repository
functions were reachable with any `{organisationId, branchId}` at all. Fixed by adding
`ListPrincipal` and `requirePharmacyPrincipal`, applied at the route and again in both repository
functions (section 2.5).

After the three fixes, `ℹ tests 39 | pass 39 | fail 0`, and the full non-database suite is
`ℹ tests 370 | pass 370 | fail 0`.

Two assertions in existing tests were changed as a consequence, both recorded rather than quietly
adjusted:

- `a foreign-scope cursor is refused exactly like a malformed one` asserted `entries` was empty, i.e.
  that no transaction was opened. That assertion *encoded defect 1*. It now asserts the repository is
  never called, which is the invariant that actually matters; the byte-identical-refusal check is
  unchanged and still passes.
- `quantities are exact decimal strings...` asserted `outstandingQuantity === '0'` for `quoted`. That
  line moved into the new dedicated test with the opposite expectation.

One case was added that passed on first run and is a regression guard, not evidence of a fix:
`a page never exceeds the requested limit even if the client returns more rows` — it hands the
repository ten rows for a `limit=2` request and asserts the slice, not the statement's `LIMIT`, is
what bounds the response.

### 5.2b RED then GREEN: the original build

Tests were written before the implementation. First run, with both source modules absent:

```
$ node --experimental-strip-types --test apps/api/test/list-routes.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../apps/api/src/list-routes.ts'
ℹ tests 1 | pass 0 | fail 1
```

That is a weak RED — a whole-file load failure, not 29 individually failing assertions — and is
reported as such. The meaningful signal came from the first run **after** implementing both modules:

```
ℹ tests 29 | pass 26 | fail 3
✖ malformed, oversized and non-canonical cursors are refused
✖ an order summary reports counts only and never another party or a fabricated total
✖ a denied membership is reported as 403 without disclosing the scope
```

All three were defects in the **test assertions**, not in the modules, and all three are worth
recording because two of them were assertions that could not have failed for the right reason:

1. `encode({ ..., a: NEED.id.toUpperCase() })` asserted that a non-lowercase uuid is refused, but
   `NEED.id` is all digits, so `toUpperCase()` was a no-op and the cursor was legitimately valid. A
   scratch probe (section 5.5) identified it. Fixed by introducing `LETTERED_UUID`, a canonical uuid
   that actually contains hex letters. The rule itself was already correct.
2. The order-disclosure regex included `/total/i`, which matched the module's own legitimate
   `lines.total` count. Replaced with precise key and pricing-vocabulary checks plus an exact
   `Object.keys` comparison.
3. The 403 regex included `/SELECT/i`, which matched the word "selected" in
   `"The selected scope is not permitted."`. Replaced with `\bSELECT\b` plus the actual tenant ids.

After fixing the three assertions: `ℹ tests 29 | pass 29 | fail 0`.

Two further assertions were tightened pre-emptively rather than after a failure: two `doesNotMatch`
checks originally ran against the whole response body, which contains a random correlation uuid that
can legitimately contain a hex fragment such as `abc` or `aaaa` (roughly a 0.7% and 0.04% chance of a
spurious failure per run). They now run against `error.message`.

### 5.3 Database tests: written first, execution awaits the coordinator

`packages/db/test/lists.test.ts` was written before the implementation and **was not executed here**.
Neither RED nor GREEN is claimed for it. It needs a coordinator-serialised `pharmacart_test` run. It
asserts, over real PostgreSQL through the authenticated Fastify API with a real local OIDC token:

1. a branch sees exactly its own four needs in deterministic uuid order, with no `total`/`count` key
   and no trace of the other tenant's `SYN-B-PRIVATE`;
2. a verified mapping discloses `productId` and `saleUnit: "box"`; an unmapped need and a need whose
   map is `review` disclose neither, and the `review` case reports `mappingStatus: "unverified"`;
3. `requested_quantity` of `2.500` survives as the string `"2.500"`, and a `closed` need reports
   `outstandingQuantity: "0"` while keeping `quantity: "4"`;
4. every field shared with `/v1/needs/:id` is identical, and the only new keys are the four
   documented mapping additions;
5. the `status=open` filter selects three of four needs; eleven malformed or injection-shaped
   queries are refused `400` and the `need` row count is still 5 afterwards;
6. a `limit=1` keyset walk visits all four ids exactly once in uuid order, and replaying one cursor
   twice returns a byte-identical page;
7. a cursor is refused across a tenant, a branch, a resource and a filter, with the foreign-tenant
   refusal byte-identical to the malformed one;
8. organisation B sees only its own need; wrong-branch and wrong-organisation headers give `403`;
   unauthenticated gives `401`; a revoked membership gives `403` on both list routes;
9. with `SET LOCAL ROLE pharmacart_runtime` and **no** tenant GUC set, both repository functions
   return zero rows; after setting organisation B's GUCs the same statements return only B's row; and
   with those GUCs still set — so the policy would have allowed the read — a `supplier` principal is
   refused `403` by both functions, proving the pharmacy-side gate is independent of the policy;
10. an approved quote produces one order intent that lists as `state: "queued"`,
    `lines: {total: 0, settled: 0, awaitingReceipt: 0}`, `uncertainty: null`, with exactly seven keys
    and no supplier id, quote id or pricing in the body; organisation B sees none of it.

What only the integration run can decide, and what the route-boundary run explicitly does **not**
prove: that the two statements are valid PostgreSQL and return the columns claimed. Specifically
unverified here are `count(...) FILTER (WHERE ...)::int`, the `jsonb_typeof(p.identity->'saleUnit')`
gate, `set_config('statement_timeout', ...)` under the `pharmacart_runtime` role, the `LEFT JOIN`
behaviour when RLS hides a `source_product_map` row, and — importantly — that PostgreSQL's `uuid`
ordering matches the hex-string comparator the tests use to predict page order.

### 5.4 Regression guards added after the implementation

Six repository-shape cases in `apps/api/test/list-routes.test.ts` were written **after** the modules
and passed on first run (five in the original build, one added by the review pass). They are
regression guards, not evidence of a fix, and are labelled as such in the file. They record the
statements the repository issues against a fake client — no SQL is
executed — and assert: exactly one bound statement plus the timeout; `params` are
`[status, after, limit + 1]`; no caller value appears in the statement text; ordering is
`ORDER BY <t>.id` with a keyset comparison and no `OFFSET`; no `organisation_id`/`branch_id`
predicate; no `supplier_id`/`quote_id`/`request_hash`; a SQL-shaped status still travels as a
parameter; the probe row is never returned and a cursor appears only when a further row exists; an
unbounded query is refused before any statement is issued; and a page never exceeds the requested
limit even when the client returns far more rows than the statement's `LIMIT` would have allowed.

### 5.5 Scratch probe

Kept **outside** the worktree at
`C:\Users\Ghareeb\AppData\Local\Temp\pharmacart-lists-probe\probe.mjs`. It executes no SQL. It runs
every rejected cursor through `parseListQuery` + `bindListQuery` and prints which one escapes,
which is how the `toUpperCase()` no-op in section 5.2 was found:

```
refused     : tampered fingerprint INVALID_CURSOR
NOT REFUSED : uppercase id {"limit":25,"status":null,"after":"40000000-0000-4000-8000-000000000001"}
```

## 6. Deployment blockers and limitations

Reported concretely. **This is not production-ready, and nothing here is a substitute for independent
coordinator review before integration.**

1. **The endpoints do not exist yet.** The module is unregistered by design. Until the coordinator
   applies the hook in section 1.1, `/v1/needs` and `/v1/orders` return 404.
2. **The database suite has never run.** Everything in section 5.3 is an intention, not a result. The
   statements in `lists.ts` have not been executed against PostgreSQL even once. Treat the SQL as
   unproven until that run passes.
3. **No OpenAPI description.** `packages/contracts/openapi.json` does not describe these two paths,
   and contracts are not this lane's to regenerate. This is a publication gate, not a runtime one:
   `apps/api/test/openapi.test.ts` does not enumerate routes, so registration will not break it.
4. **`INVALID_CURSOR` is a new error code** crossing the API boundary. Error codes are free-form in
   `apps/api/src/errors.ts` and are not enumerated in the generated contracts, so nothing breaks, but
   the OpenAPI error vocabulary should adopt it before publication — the same note
   `docs/testing/procurement-invariants.md` made for its two codes.
5. **No role restriction inside a pharmacy.** The organisation-kind gate is now enforced
   (section 2.5), but any active member of the branch — `pharmacy_owner`, `purchaser`, `receiver` or
   `support` — can list both resources. That is deliberate parity with `/v1/needs/:id` and
   `/v1/orders/:id`, which behave the same way, and the write paths give no usable precedent because
   they disagree: `createQuote`/`approveQuote` admit `pharmacy_owner|purchaser` while `confirmReceipt`
   admits `pharmacy_owner|receiver`. Whether a `receiver` should see order summaries, or a
   `purchaser` need summaries, is a policy decision **for the coordinator**. It has not been made,
   and this lane did not invent one. `context.role` is available at both enforcement points, so
   whatever is decided is a one-line addition to `requirePharmacyPrincipal`.
6. **Index support at volume is unverified.** `ORDER BY id LIMIT` can use the primary key, but with a
   `status` filter and the RLS predicates, PostgreSQL may scan and filter. At synthetic volumes this
   is irrelevant; at real volumes `need(status, id)` and `order_intent(state, id)` are likely needed.
   Adding them is a migration and is not owned here.
7. **`LIST_STATEMENT_TIMEOUT_MS` is a constant, not configuration.** 5000 ms is a guess, not a
   measurement. It cannot be tuned without an edit because this lane owns no configuration surface.
8. **Row content is not bounded.** The item count is capped at 100, but `need.product_ref` and
   `order_intent.external_client_ref` are unbounded `text` in the schema, so a single response is
   bounded by row content the tenant itself wrote. Not a cross-tenant issue; still a payload-size
   consideration for a public deployment.
9. **`GET /v1/scopes` is pending** (section 3). The web flow must keep asking the user for explicit
   organisation and branch selectors until the coordinator decides on the proposed function.
10. **The cursor is not authenticated.** It is a digest, not a MAC. That is sufficient because row
    level security bounds the result regardless, but it does mean a client can read its own cursor's
    contents. If a future cursor ever carries a value the client should not see, it needs a keyed
    MAC, and there is no key management in this project to hang one on.
11. **A timed-out list is indistinguishable from a bug.** When `statement_timeout` fires, PostgreSQL
    raises SQLSTATE `57014`, which `classifyError` does not recognise, so the caller sees
    `500 INTERNAL_ERROR` — the same response as a genuine defect. That is safe (it discloses nothing)
    but unhelpful: a client cannot tell "retry with a smaller `limit`" from "this is broken". Mapping
    it to a distinct code means either a new branch in `apps/api/src/errors.ts` or pg-specific error
    inspection in the route; neither was done, because the first is not this lane's file and the
    second puts driver knowledge in a route. Flagged for the coordinator.
12. **`outstandingQuantity` is nullable and a client must handle it.** It is `null` for any need
    status whose outstanding-demand meaning the schema does not record (today: `quoted`; see
    section 2.4). A consumer that treats the field as always-a-string will break on it. This is
    intentional — the alternative is asserting a number the database does not support — but it is a
    contract detail that has to reach the OpenAPI description in limitation 3 when it is written.
13. **Concurrency and restart behaviour is inherited, not added.** These are read-only handlers with
    no lock, lease, retry or background work, so there is no new failure or restart path to evidence.
    Pagination stability across *concurrent writes* is explicitly **not** claimed: a keyset guarantees
    no skip or duplicate for unchanged rows only. A need whose status changes between two pages can
    legitimately leave or enter the filtered set. That is standard keyset behaviour and is documented
    here rather than asserted away.
