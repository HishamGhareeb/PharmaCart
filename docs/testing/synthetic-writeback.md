# Synthetic receipt writeback: review and integration

Branch `claude/receipt-writeback`, based on `cd4bb7e`. Integrates the earlier isolated writeback lane (based
on `9584ace`, never integrated) after an adversarial review. Design reference:
[../receipt-writeback.md](../receipt-writeback.md).

**Status: not accepted.** No database test in this file has been run by its author. The coordinator runs the
PostgreSQL suite serially and records current RED and GREEN evidence. The earlier lane's recorded evidence
was produced on a different base against code that has since been rewritten, and is not carried forward.
AC-010 and AC-014 remain NOT RUN.

## What was integrated

| File | From the lane | Change |
| --- | --- | --- |
| `packages/writeback/src/payload.ts` | yes | Unchanged |
| `packages/writeback/src/sink.ts` | yes | Unchanged |
| `packages/writeback/src/synthetic-entry.ts` | yes | Unchanged |
| `packages/writeback/test/{payload,sink,synthetic-entry}.test.ts` | yes | Unchanged |
| `packages/writeback/src/processor-policy.ts` | no | New: bounds, sink call deadline, failure classification |
| `packages/writeback/test/processor-policy.test.ts` | no | New |
| `packages/writeback/test/inclusion-boundary.test.ts` | no | New: static inclusion and write-scope guard |
| `packages/db/migrations/0018_writeback_attempts.sql` | renumbered from `0017_writeback_attempts.sql` | Rewritten |
| `packages/db/src/writeback.ts` | yes | Rewritten |
| `packages/db/test/writeback.test.ts` | yes | Rewritten |

The migration is `0018`; `0016` and `0017` are reserved for other builders. Nothing refers to the old name.
Migrations `0013` to `0015` did not exist on the lane's base. The lane touched none of their tables except
`receipt_writeback`, which `0014` extended with inclusion columns; the rewrite leaves those columns alone.

## Review findings

Each finding below was traced against the lane's `packages/db/src/writeback.ts` and
`0017_writeback_attempts.sql`, and has a regression test written before its fix. The "lane behaviour" column
is a prediction from reading the code, not a recorded run.

### 1. The restore guard covered only the first batch (duplicate delivery)

`reconcileQueued()` looked up `LIMIT batch` queued writebacks, then set a process-wide flag enabling dispatch
for all of them. After a restore that lost attempt state, every queued row beyond the first batch had no
attempt row, and the lane's first claim of such a row went straight to `apply`. A row whose startup lookup
was inconclusive was also skipped and then sent. The synthetic sink hid this by deduplicating internally;
any sink that does not guarantee idempotency would record a second stock receipt.

Fix: the lookup is part of every claim. A claim commits phase `checking`, looks up, and sends only after
committing `submitting`. `reconcileQueued()` and the dispatch flag are removed.

Tests: `lost attempt state is resolved by lookup for every queued writeback, however large the queue`;
`a confirmed receipt is delivered once, after a lookup, and inclusion stays unrecorded`; the AC-014
restore test.

### 2. A lease identified the worker, not the claim (duplicate delivery, unknown outcome)

The lease owner was one UUID per processor instance, and a claim was refused only when a live lease belonged
to a *different* owner. A concurrent `process()` or `runOnce()` in the same instance re-claimed a live
`submitting` attempt, ran the recovery lookup before the original send had landed, found nothing and held
the writeback. Against a sink that guarantees idempotency it released it for another send instead. This is
the stale not-found lookup the order path already fixed (order-recovery-concurrency.md, defect 3).

Fix: `lease_token`, minted per claim. Only the current token may change a non-applied phase, and a live lease
is refused before any other check.

Test: `a second call in the same worker cannot take over a send that is still in flight`.

### 3. Positive evidence from an overtaken send was discarded

The settling transaction required the lease owner. A send whose lease expired while it was in flight, and
whose recovery was held by another worker, landed with matching evidence that was then thrown away. The sink
held the receipt while the database said held and queued.

Fix: positive evidence that matches the recorded key, payload hash, token and line count is recorded as
applied whoever holds the lease. Holds remain reserved to the current claim.

Test: `a send that had not reached the sink when its lease expired is held, and its late evidence is still recorded`.

### 4. A sink call could wait forever (bounded waits)

`apply` and `lookup` were awaited with no deadline. The `StockReceiptSink` interface makes no timing promise;
only the synthetic sink bounds its own lock wait, and up to 60 s, which could exceed a 1 s lease. A hung sink
hung the worker with nothing recorded, and its lease could expire while the call was still live.

Fix: every sink call runs under `sinkCallTimeoutMs`. `leaseMs` must be at least twice that bound, and the
lease is extended before each call. A timeout on `apply` is an unknown outcome and settles only by lookup.

Tests: `a hung sink is abandoned at its deadline and the attempt is recorded as unknown`;
`processor-policy.test.ts`.

### 5. A transient refusal exhausted every attempt in one run (bounded retries)

A released attempt had no lease and no delay, and `runOnce` kept claiming until `batch`. One run therefore
re-claimed the same writeback up to `batch` times in milliseconds. A momentary ledger lock or lookup outage
used up `maxAttempts` at once and escalated to an operator hold.

Fix: `not_before` and `retryDelayMs`. One run processes each writeback at most once.

Test: `a transient refusal waits for its retry delay instead of exhausting every attempt in one run`.

### 6. One unbuildable receipt blocked the queue, unrecorded (bounded retries, partial failure)

A payload build error, such as a non-canonical quantity or a line without an order snapshot, threw inside the
claim transaction. The transaction rolled back with no attempt recorded and `runOnce` rejected. The next run
picked the same row first again, so every later writeback for the tenant was blocked and the attempt bound
was never reached. `reconcileQueued()` reported such a row as `needs_reconciliation` without persisting it.

Fix: the row is held as `payload_unbuildable` in the claim transaction and logged. `payload_hash` may be NULL
only for that hold.

Test: `a receipt whose payload cannot be built is held without blocking the rest of the queue`.

### 7. Settlement failures were thrown, and lock order invited deadlock (partial failure)

A lock timeout (the lane's own `lockTimeoutMs`) or a deadlock in a settling transaction rejected `runOnce` or
`process()` after the sink had already recorded the receipt, aborting the rest of the batch. The lock order
also differed. A claim locked `receipt_writeback` and then the attempt row. The applied settlement locked the
attempt and then updated `receipt_writeback`. The unknown and hold settlements locked only the attempt. A
claim and a settlement on one row could therefore deadlock.

Fix: every transaction locks the writeback row first. Lock timeout, deadlock and serialisation failures
return named refusals. A rolled-back settlement leaves the attempt in `submitting`, which forces a lookup, so
nothing is half-applied and nothing is resent.

Tests: `a settlement that cannot take its lock leaves no half-applied state and is recovered by lookup`
(deterministic); `competing workers and concurrent calls in one worker deliver a writeback exactly once`
(a stress guard; a deadlock there is timing-dependent, so a pass is not proof of its absence).

### 8. Attempt rows were not bound to their writeback's tenant (tenant isolation)

`receipt_writeback_attempt.writeback_id` referenced `receipt_writeback(id)` alone, with independent tenant
columns. Foreign key checks bypass row security. A runtime session in tenant B could therefore insert an
attempt row naming tenant A's writeback under B's own tenant columns, which passes B's policy. That would
squat A's primary key: A cannot see the row, and A's claim insert then fails on every run. The processor could
not do this, because its reads are tenant-scoped, but the schema did not enforce it.

Fix: `UNIQUE(organisation_id, branch_id, id)` on `receipt_writeback` and composite foreign keys from both new
tables.

Test: `row security holds for every writeback read and write`.

### 9. A live claim could be held out from under its send

The lane's claim checked a changed payload hash and a disagreeing applied phase before the live-lease check.
A competing call could therefore hold a writeback whose send was in flight and clear that claim's lease.

Fix: the live lease is checked first. A receipt that changed during a live send is judged by the owning
claim, which re-derives the payload under lock before recording evidence.

Test: `a receipt that changes during a live send is judged by that send, not held out from under it`.

### 10. Attempts were not recorded, and refusals were not named

Only the latest detail survived, overwritten on each step, and startup lookups were not recorded at all.
Outcomes carried free text only, and `FORBIDDEN` and `NOT_FOUND` were thrown.

Fix: `receipt_writeback_attempt_log`, append-only for the runtime role, with one row per sink call and per
claim-time hold. Outcomes are discriminated unions with a named reason.

Tests: the `steps` assertions throughout; `the queued/applied domain is not widened and attempt history is append-only for the runtime role`.

Also corrected: a claim that had lost its lease reported `queued` even when the writeback was already
applied. It now reports the durable state (covered by the two lost-claim tests).

### 11. Runtime role had table-wide UPDATE on attempts (least privilege; raised by coordinator review)

`GRANT SELECT,INSERT,UPDATE ON receipt_writeback_attempt` let the runtime role rewrite `writeback_id`,
`organisation_id`, `branch_id`, `sink_key`, `payload_hash` and `created_at`. That would allow re-keying an
attempt, moving it to another tenant, or rewriting the payload hash it vouched for.

Fix: column-level `GRANT UPDATE(phase, attempts, lease_token, lease_expires_at, not_before,
sink_receipt_token, hold_reason, last_reason, last_detail, updated_at)`. That is exactly the union of the
columns set by the five direct UPDATEs and the two `ON CONFLICT DO UPDATE` statements in `writeback.ts`.

Tests: `the runtime role may update only the attempt columns the processor writes` (database), and
`the attempt UPDATE grant is exactly the set of columns the processor writes` (static). The static test was
run before the grant change and failed on the table-wide grant, then passed after it.

### Inclusion

The lane predates the inclusion columns and did not write them. The rewrite does not name them anywhere in
source or migration, and the only write to `receipt_writeback` is `status = 'applied'`. Guarded statically
by `inclusion-boundary.test.ts` and asserted NULL after every delivery in the database suite.

## Tests and commands

### Runnable without PostgreSQL

```
node --experimental-strip-types --test packages/writeback/test/*.test.ts
```

36 tests: payload (8), sink (14) and synthetic entry (5) from the lane, unchanged; processor policy (6),
inclusion boundary (2) and attempt grants (1), new. These are not in any npm script yet (see below).

### PostgreSQL: awaiting the coordinator

Whole file:

```
node --test --test-concurrency=1 packages/db/test/writeback.test.ts
```

One test: add `--test-name-pattern="<exact test name>"`. The file is already matched by the
`test:integration` and `test:coverage` globs (`packages/db/test/*.test.ts`). Each test resets
`pharmacart_test`; the last also runs `pg_dump` and `pg_restore` through Docker, like `supplier.test.ts`.

| Test | Finding |
| --- | --- |
| the queued/applied domain is not widened and attempt history is append-only for the runtime role | 10 |
| the runtime role may update only the attempt columns the processor writes | 11 |
| a confirmed receipt is delivered once, after a lookup, and inclusion stays unrecorded | 1, inclusion |
| competing workers and concurrent calls in one worker deliver a writeback exactly once | 2, 7 |
| a second call in the same worker cannot take over a send that is still in flight | 2 |
| a worker that died after the sink recorded the receipt is recovered by lookup, never by a resend | restart |
| a send that had not reached the sink when its lease expired is held, and its late evidence is still recorded | 3 |
| a claim that lost its lease during the pre-send lookup never sends | 1, 2 |
| an unanswered apply is settled by lookup in the same run and never resent | unknown outcome |
| a hung sink is abandoned at its deadline and the attempt is recorded as unknown | 4 |
| an unknown outcome no lookup can settle is never applied or resent, and escalates after bounded attempts | 5, unknown outcome |
| a transient refusal waits for its retry delay instead of exhausting every attempt in one run | 5 |
| a receipt whose payload cannot be built is held without blocking the rest of the queue | 6 |
| a receipt that changed under a recorded attempt is held, not resent | payload change |
| a receipt that changes during a live send is judged by that send, not held out from under it | 9 |
| without an idempotency guarantee "not found" after an unanswered send holds; with one a checked resend is permitted | unknown outcome |
| a settlement that cannot take its lock leaves no half-applied state and is recovered by lookup | 7 |
| row security holds for every writeback read and write | 8 |
| lost attempt state is resolved by lookup for every queued writeback, however large the queue | 1 |
| AC-014 shape: an actual database restore reuses the retained stock receipt instead of sending again | 1 |

Reproducing RED needs the lane's module, whose API differs: it requires `reconcileQueued()` and has no reasons,
no `checking` phase and no log table. Most tests would therefore fail against it on shape before reaching the
defect. The predicted lane behaviour for each finding is stated above.

## Coordinator actions required

1. Apply and review `0018_writeback_attempts.sql`, then run `packages/db/test/writeback.test.ts`.
2. Add `packages/writeback/test/*.test.ts` to the root `test` and `test:coverage` globs. The root
   `package.json` is coordinator-owned and was not edited.
3. No `orders.ts` change is needed: `confirmReceipt` already queues exactly one writeback per receipt.

## Coordinator verification

Run by the coordinator, the single database test runner, on this worktree at base `cd4bb7e`, against a freshly dropped and recreated `pharmacart_test`. The builder ran the package suite and was barred from running any database test.

RED at the module boundary, with `packages/db/src/writeback.ts` moved aside and then restored: `ERR_MODULE_NOT_FOUND`. The builder recorded the grant regression before narrowing it: the static grant test failed with a table-wide UPDATE grant is not least privilege.

GREEN, after the column-level grant change:

| Command | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `node --experimental-strip-types --test packages/writeback/test/*.test.ts` | 36 | 36 | 0 |
| `node --experimental-strip-types --test --test-concurrency=1 packages/db/test/writeback.test.ts` | 20 | 20 | 0 |
| `npm run typecheck`, `npm run lint` | | pass | |

The database suite includes the AC-014 restore test, which runs `pg_dump` and `pg_restore` through Docker, and the new privilege test proving the runtime is refused an update of each protected attempt column.

## Coordinator review notes

**Least privilege now matches the notification tables.** The runtime holds column-level UPDATE on exactly the ten attempt columns the processor writes, checked against all seven update statements. `writeback_id`, `organisation_id`, `branch_id`, `sink_key`, `payload_hash` and `created_at` are unwritable, there is no DELETE, and the attempt log is append-only. The tenant-squatting defect is closed by composite foreign keys.

**An applied writeback is still not inclusion.** Nothing writes `included_snapshot_id` or `included_sequence`, enforced by a static test and asserted by the database tests. Releasing the receipt holds that need reconciliation now places requires the inclusion writer, which joins this lane to the feed persistence sink.

**One gap stays open.** An attempt that exhausts its retries while its outcome is unknown is held without a final lookup. That is safe, since nothing is resent, but it can hold a receipt the sink already recorded.

**Integration needs `packages/writeback/test/*.test.ts` added to the root `test` and `test:coverage` scripts.**
