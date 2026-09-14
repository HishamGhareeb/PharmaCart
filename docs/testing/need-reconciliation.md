# Commitment-aware need reconciliation: identifier guards and receipt-inclusion lifecycle

Branch: `claude/need-reconciliation-guards`, based on cd4bb7e. Builder lane, coordinator review pending.
Date: 2026-09-14.

Status: the reconciliation module, its procurement enforcement and its tests are integrated from the earlier
`claude/need-commitments` lane (tmp/claude-needs, based on 9584ace) and corrected. The pure `policy:` and `guard:`
tests have real RED and GREEN below. The seventeen `database:` tests are written and **have not been run**;
builders do not touch `pharmacart_test`. No acceptance criterion moves on this evidence.

## 1. What was integrated, and what changed on the way

`packages/db/src/procurement.ts` and migration 0014 were identical between the lane's base and cd4bb7e, so the
lane's procurement diff applied cleanly and 0014 needed no change. `inventory.ts` still runs the old
commitment-blind arithmetic; wiring reconciliation into ingestion stays out of scope (section 7).

The design approved in the lane review is kept unchanged:

- Commitments are counted per intent state (`commitmentBasisByIntentState`). Submitting, outcome-unknown and
  human-review orders **hold** their need with `unknown_order_state`; nothing is guessed high or low.
- Receipt inclusion is recorded positively or not at all. An applied writeback is delivery evidence only.
  An unproven inclusion keeps `need.hold_reason = 'receipt_inclusion_unproven'`.
- `createQuote` and `approveQuote` refuse a held need with `409 RECONCILIATION_REQUIRED`. A recorded approval
  replay still returns its recorded result.
- Reconciliation locks affected need rows `FOR UPDATE` in primary key order. Approval takes its need locks in
  the same order, so the two queue rather than deadlock.

## 2. The identifier guard defect

Nothing between a caller and PostgreSQL checked that an identifier was a canonical UUID. PostgreSQL makes that
dangerous in two ways. Upper case, braced and unhyphenated spellings cast to the same `uuid`, but they are
different strings to JavaScript. Anything else raises `22P02`, which aborts the caller's transaction and names
nothing.

| Entry point | Identifier | Where it went unchecked |
| --- | --- | --- |
| `reconcileInventoryNeeds` | `installationId` | Straight into the `FOR UPDATE` lock statement and the assessment query. A malformed value aborted the caller's transaction (in the intended wiring, the feed ingest). The nil UUID locked nothing and "succeeded". |
| `readNeedHold` | `needId` | Straight into the hold read. An invisible or non-existent need returned `null`, which quoting reads as "remainder proven". |
| `createQuote` | `lines[i].needId` | **The root defect.** The need lookup accepted any spelling PostgreSQL accepts, and `{...line}` persisted the caller's raw string into `quote.lines`. A lower- and an upper-case spelling of one need also passed the `DUPLICATE_NEED` Set check as two needs. |
| `approveQuote` | `quoteId` and stored `lines[i].needId`, `offerId`, `supplierId` | The raw stored strings drove the need row locks, the per-supplier intent grouping, and the lock order `a.needId.localeCompare(b.needId)`. That order agrees with `ORDER BY n.id` only for canonical spellings: `'{'.localeCompare('0')` is `-1`, but `{` sorts after every hex digit byte-wise. A braced or unhyphenated need id could invert approval's lock order against reconciliation. |
| Reconciliation SQL | `quote.lines->>'needId'`, `->>'supplierId'`, `receipt.lines->>'lineId'` | Cast with `::uuid` over every quote and receipt visible to the branch. One malformed stored line raised `22P02` in every recalculation **and** every hold read in the branch, so it blocked unrelated quoting as well. A receipt line naming no order line was dropped from the hold silently, although its received quantity had already reduced the outstanding commitment. |

### How each is now refused

- `decideCanonicalUuid(value)` is the one decision. It accepts only lowercase hyphenated 8-4-4-4-12, rejects the
  nil UUID, and names every refusal: `not_a_string`, `malformed`, `non_canonical` (the same 128 bits spelled
  another way, which is the case PostgreSQL would silently accept), or `nil`. Version and variant nibbles are
  not policed, which matches `apps/api` `selector()` and the contract pattern.
- `reconcileInventoryNeeds` and `readNeedHold` throw `NeedReconciliationError` with
  `refusal: { kind: 'invalid_identifier', field, reason }` **before any statement or lock**. `readNeedHold`
  throws `{ kind: 'need_not_visible', needId }` instead of returning `null` for a need it cannot see.
- `createQuote` validates every `lines[i].needId` before the duplicate check and before any read:
  `ProcurementError(422, 'INVALID_IDENTIFIER', { field: 'lines[0].needId', reason })`. Only canonical ids can
  now be persisted into a quote.
- `approveQuote` validates `quoteId` before the advisory lock
  (`422 INVALID_IDENTIFIER`, field `quoteId`). It validates each stored `needId`, `offerId` and `supplierId`
  before any need lock (`409 REQUOTE_REQUIRED`, field `lines[i].<name>`): the stored quote cannot be approved
  as written, and a fresh quote from canonical input is the remedy. Need locks are sorted with
  `compareCanonicalUuids`, a code-unit comparison that equals uuid byte order and does not depend on locale.
- The reconciliation SQL no longer casts anything read from jsonb. Each stored identifier is compared as text
  with the canonical rendering of a real key (`s.id::text`, `i.supplier_id::text`, `l.id::text`), which only a
  canonical spelling can equal. A non-array or empty line list reads as one null line instead of raising.
  The quoted-quantity cast is now nested inside its regex `CASE`, because `AND` has no guaranteed evaluation
  order in PostgreSQL.
- A stored line that cannot be attributed is never dropped. This covers a line whose supplier matches no order of
  its quote, or whose need is not canonical, on any unsettled order in the branch. It holds every need of the
  installation, and every need a hold read is asked about in that branch, with `unverified_commitment`: its
  quantity could belong to any of them. `resolveHold` takes the strongest of the live reasons and the stored
  one, so this never outranks `unknown_order_state` or `receipt_inclusion_unproven`.

`ProcurementError` gained an optional third constructor argument, `detail: { field, reason } | null`. Existing
two-argument calls are unchanged. `apps/api` forwards only `status` and `code`, so detail stays server-side.

## 3. Receipt-inclusion lifecycle corrections

Inclusion is still recorded positively or not at all, and nothing writes it yet. Within that design, three holes
let a received quantity leave the commitment without the hold that should replace it:

1. **A receipt with no writeback record was invisible.** The lane's query started from `receipt_writeback`. It
   now starts from `receipt` and left-joins the writeback, so a missing record is unproven.
2. **A sequence number stood in for the snapshot.** Proof required `projection.sequence >= included_sequence`
   and ignored `included_snapshot_id`. At the recorded sequence, the observed snapshot identity must now equal the
   recorded one. A strictly later fresh sequence still proves inclusion, as approved.
3. **An unattributable receipt line was dropped** (section 2). A receipt line naming none of its order's lines
   now holds every need of that order.

Migration 0014's column comments still describe the rule accurately. No new migration was needed: every
correction is a query change.

## 4. Public surface

```ts
// packages/db/src/need-reconciliation.ts
export type IdentifierRefusalReason = 'not_a_string' | 'malformed' | 'non_canonical' | 'nil';
export function decideCanonicalUuid(value: unknown):
  { kind: 'canonical'; value: string } | { kind: 'refused'; reason: IdentifierRefusalReason };
export function compareCanonicalUuids(left: string, right: string): -1 | 0 | 1;
export type NeedReconciliationRefusal =
  | { kind: 'invalid_identifier'; field: string; reason: IdentifierRefusalReason }
  | { kind: 'need_not_visible'; needId: string };
export class NeedReconciliationError extends Error { readonly refusal: NeedReconciliationRefusal }
export async function reconcileInventoryNeeds(client: RuntimeClient, installationId: string): Promise<void>;
export async function readNeedHold(client: RuntimeClient, needId: string): Promise<HoldReason | null>;
export type HoldObservation = { storedReason; unresolvedOrder; receiptInclusionUnproven; unattributableCommitment };

// packages/db/src/procurement.ts
export type ProcurementRefusalDetail = { field: string; reason: IdentifierRefusalReason };
export class ProcurementError extends Error { readonly status; readonly code; readonly detail: ProcurementRefusalDetail | null }
```

```ts
await withTransaction(pool, subject, organisationId, branchId, async (client) => {
  try {
    await reconcileInventoryNeeds(client, installationId);
  } catch (error) {
    if (error instanceof NeedReconciliationError && error.refusal.kind === 'invalid_identifier') {
      // error.refusal.field === 'installationId'; nothing was read, locked or written, and the transaction is usable.
    }
    throw error;
  }
});
```

## 5. Evidence

### Pure tests: how they were run

The testing rule forbids running anything under `packages/db/test`. The `policy:` and `guard:` section of
`packages/db/test/need-reconciliation.test.ts` was therefore copied verbatim into a scratch file. The copy drops
the marked database-only import block, stops at the `// BEGIN database tests` marker, and rewrites `../src/`
imports to absolute paths. That copy was run with `node --experimental-strip-types --test`; it imports nothing
that opens a connection.

### RED, stage 1: the lane's module and procurement diff, with the regression tests

```
✔ policy: (6 lane policy tests)
✖ guard: reconciliation refuses an installation identifier that is not a canonical UUID before any query or lock
  AssertionError [ERR_ASSERTION]: Missing expected rejection: malformed: not-a-uuid
✖ guard: a hold read refuses a need identifier that is not a canonical UUID before any query
  AssertionError [ERR_ASSERTION]: Missing expected rejection: malformed: not-a-uuid
✖ guard: quoting refuses a need identifier that is not a canonical UUID before it is read or persisted
  404 !== 422
✖ guard: two spellings of one need cannot pass the duplicate check as two needs
  404 !== 422
✖ guard: approval refuses a quote identifier that is not a canonical UUID before any lock
  404 !== 422
✖ guard: approval refuses a stored line identifier that is not a canonical UUID before any need lock
  + 'BUDGET_EXCEEDED'
  - 'REQUOTE_REQUIRED'
✔ guard: approval takes need locks in the byte order PostgreSQL uses for ORDER BY id
ℹ tests 13  ℹ pass 7  ℹ fail 6
```

`404` means the malformed id went into the need lookup. `BUDGET_EXCEEDED` means approval locked the need, read
its hold and reached the budget with a stored `not-a-uuid` need id. The lock-order test is a pin, not a
regression: for canonical lowercase ids `localeCompare` and byte order agree, and the non-canonical ids that
break the agreement are now refused before sorting.

### RED, stage 2: tests for the new pure helpers

```
SyntaxError: The requested module '.../need-reconciliation.ts' does not provide an export named 'compareCanonicalUuids'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

### GREEN

```
✔ policy: an intent state decides how its quantity is counted and an unmodelled state is never guessed
✔ policy: a commitment whose unit, lineage or quantity cannot be proven holds instead of counting
✔ policy: a live unresolved order outranks a cached hold flag and a clean read clears nothing it did not prove
✔ policy: a live commitment that names no provable need holds as unverified without outranking a stronger reason
✔ policy: an applied writeback is delivery evidence and never proof that a snapshot carried the receipt
✔ policy: a held need or an unusable observation is preserved, never recomputed
✔ policy: a proven remainder opens, updates, reopens or closes a need and repeats without churn
✔ policy: an identifier is canonical only as a lowercase hyphenated non-nil UUID, and every other spelling is refused by reason
✔ policy: canonical identifiers compare in the byte order of the uuid type, independent of locale
✔ guard: reconciliation refuses an installation identifier that is not a canonical UUID before any query or lock
✔ guard: a hold read refuses a need identifier that is not a canonical UUID before any query
✔ guard: a hold read for a need it cannot see refuses by name instead of reporting a proven remainder
✔ guard: quoting refuses a need identifier that is not a canonical UUID before it is read or persisted
✔ guard: two spellings of one need cannot pass the duplicate check as two needs
✔ guard: approval refuses a quote identifier that is not a canonical UUID before any lock
✔ guard: approval refuses a stored line identifier that is not a canonical UUID before any need lock
✔ guard: approval takes need locks in the byte order PostgreSQL uses for ORDER BY id
ℹ tests 17  ℹ pass 17  ℹ fail 0
```

One intermediate run failed on a fixture bug in the test, not the code: `offerId ?? default` replaced the
`undefined` spelling under test. The fixture now uses `'offerId' in line`.

Also observed on this revision: `npm run typecheck` and `npm run lint` are clean. `npm test` passes 514 of 514
(database-free). `node --experimental-strip-types --test apps/api/test/*.test.ts apps/worker/test/*.test.ts`
passes 82 of 82. These are not evidence for the SQL.

### NOT RUN: awaiting coordinator

They require migrations 0001 to 0015 on a serialized `pharmacart_test`:

```
node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern "^database:" packages/db/test/need-reconciliation.test.ts
```

The whole file, pure and database tests together: `node --experimental-strip-types --test --test-concurrency=1 packages/db/test/need-reconciliation.test.ts`.

| Test | Asserts | Lane behaviour it catches |
| --- | --- | --- |
| a partial approval survives the next stock feed | 10 − 0 − 4 queued stays `open\|2\|6` | (lane test, kept) |
| an acknowledged commitment counts accepted-but-not-received | `open\|3\|7` after partial acceptance | (lane test, kept) |
| an unknown order state holds only its own need | held need refuses quote and approval; unrelated need maintained | (lane test, kept) |
| resolving the order state clears the hold | `open\|3\|7\|-`, quoting resumes | (lane test, kept) |
| a receipt holds the need until a snapshot is proven to carry it | queued and applied both hold; observed inclusion lifts | (lane test, kept) |
| an inclusion point at the recorded sequence is proven only by the snapshot it names | same sequence, other snapshot id holds; named snapshot or later sequence lifts | lane lifted the hold on sequence alone |
| a receipt with no writeback record is unproven | `open\|2\|8\|receipt_inclusion_unproven`, quote refused | lane gave `open\|3\|10\|-`: the received two boxes vanished from both sides |
| a receipt line that names no line of its order still holds every need of that order | `not-a-uuid`, nil, foreign and braced line ids all hold; restored and proven lifts | lane raised 22P02 for `not-a-uuid` and silently dropped the nil and foreign ids, so those did not hold. The braced id happened to cast and hold. |
| a stored quote line whose identifiers are not canonical holds by name | malformed need, nil supplier, braced need, non-array lines: live read and recalculation hold both needs `unverified_commitment`; restoring lifts | lane raised 22P02 for the malformed need and an error for non-array lines. It dropped the nil-supplier line, re-requesting its boxes, and counted the braced spelling without holding. |
| identifier refusals leave the transaction usable and write nothing | named refusals inside one transaction, then a successful `SELECT 1` and reconciliation; no quote persisted | lane persisted a braced need id into a quote |
| a recalculation holding the need locks queues an approval | approval observed waiting on a lock, then refuses `REQUOTE_REQUIRED` against the recalculated version; no deadlock | (new concurrency evidence) |
| an approval holding the need lock queues a recalculation | recalculation observed waiting, then counts the committed order: `open\|2\|6\|-` | (new concurrency evidence) |
| a fresh surplus closes the open need | `closed` at last positive quantity, alert retired, later shortage reopens | (lane test, kept) |
| a stale, missing or mismatched observation preserves | none erases, shrinks or invents a need | (lane test, kept) |
| repeated reconciliation of an unchanged position | no version or alert identity change | (lane test, kept) |
| an approved quote replay while the need is held | recorded result, one approval, one intent | (lane test, kept) |

The two concurrency tests poll `pg_stat_activity` for `wait_event_type = 'Lock'` from the bootstrap connection.
They bound the wait at five seconds and assert the waiting side has not settled before releasing the holder.

## 6. API mapping

None needed. `apps/api/src/tenant-api.ts` already maps every `ProcurementError` to its `status` and `code`, and
the contract's error code is a free pattern with 409 and 422 documented on these routes. So
`409 RECONCILIATION_REQUIRED`, `422 INVALID_IDENTIFIER` and `409 REQUOTE_REQUIRED` reach clients unchanged.
Through HTTP the identifier refusals are unreachable anyway, because `selector()` and `quoteCommandSchema`
already refuse non-canonical ids with `400 INVALID_REQUEST`. They guard the direct module callers and stored
data. `NeedReconciliationError` has no HTTP mapping, because neither function is exposed over HTTP. If one is
exposed later, `invalid_identifier` maps naturally to 400 or 422 and `need_not_visible` to 404.

## 7. Remaining gaps and decisions

1. **Receipt inclusion writer: not built.** Nothing writes `receipt_writeback.included_snapshot_id` or
   `included_sequence`. It depends on the feed persistence sink another builder is writing. Until it exists,
   every confirmed receipt holds the needs it touched permanently, and those needs refuse quoting and approval
   with 409. This is deliberate and is the named blocker on calling replenishment complete.
2. **Not wired into ingestion.** `inventory.ts` still runs the target-minus-stock upsert. The coordinator hook is
   unchanged from the lane: replace its two `INSERT INTO need` / `INSERT INTO inventory_alert` statements with
   `await reconcileInventoryNeeds(client, installationId)`. `installationId` there comes from
   `loadInstallation` and is the database's own canonical text.
3. **Unattributable scope is conservative.** One unattributable line on any unsettled order in a branch holds every
   need a recalculation or hold read looks at in that branch. It cannot be narrowed without guessing which need
   the line meant.
4. **Out of the reconciliation path, not changed:** `createQuote`'s `branchId` (string-compared to the context and
   refused 404) and `constraints.supplierIds` (a `uuid[]` filter whose values are never persisted). A malformed
   supplier id still raises 22P02 from a direct module call. Through HTTP it is refused 400 first.
   `orders.ts` compares `ql->>'needId'` with `need_id::text` in budget settlement. That is correct now that only
   canonical need ids can be persisted, and it was left untouched as outside this lane.
5. A need whose target was removed, or whose projection stays stale, keeps any receipt against it unproven. That is
   consistent with "absent or stale is not evidence", and is worth revisiting with the writer.
6. Alert retirement on a disproved shortage is kept from the lane; the coordinator's earlier veto option stands.

## Coordinator verification

Run by the coordinator, the single database test runner, on this worktree at base `cd4bb7e`. The builder ran the pure tests from a scratch copy and was barred from running any database test.

RED, behavioural, recorded by the builder: against the lane's original code, six guard tests failed on assertions, with no rejection, a 404 where 422 was expected, and `BUDGET_EXCEEDED` where a named refusal was expected.

RED at the module boundary, recorded by the coordinator with `packages/db/src/need-reconciliation.ts` moved aside and then restored:

```
$ node --experimental-strip-types --test --test-concurrency=1 packages/db/test/need-reconciliation.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/db/src/need-reconciliation.ts'
```

GREEN:

| Command | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 packages/db/test/need-reconciliation.test.ts` | 33 | 33 | 0 |
| `npm run test:integration`, the whole PostgreSQL suite | 75 | 75 | 0 |
| `npm run typecheck`, `npm run lint` | | pass | |

The whole integration suite was run rather than the reconciliation file alone, because quoting and approval now refuse any need a confirmed receipt touched until inclusion is proven. That could have broken existing order and receipt tests that quote after a receipt. None broke.

## Coordinator review notes

**The procurement integration is sound.** Identifiers are validated before any read or lock. Approval sorts its need locks with `compareCanonicalUuids`, which matches the database's primary key order for canonical identifiers, so a recalculation and an approval queue rather than deadlock. The hold is re-read under the need lock from live order state. Refusal detail stays server-side; the API forwards only status and code.

**The receipt hold is permanent until the inclusion writer exists, by design.** Every confirmed receipt holds the need it touched and refuses quoting until a feed snapshot proves inclusion. Once merged, this is true of the whole system, not just this lane. The inclusion writer, joining the feed persistence sink to applied writebacks, is the next integration step and is what releases those holds.
