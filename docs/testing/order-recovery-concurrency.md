# Order recovery under concurrent workers and reconciliation

Branch `claude/order-recovery-hardening`, based on df09baf. Bounded hardening slice over the synthetic
supplier ledger and the intent worker's recovery transitions. Changed files: `packages/supplier/src/fake.ts`,
`packages/db/src/orders.ts`, new `packages/supplier/test/fake-concurrency.test.ts` and new
`packages/db/test/order-recovery-concurrency.test.ts`. No migration, dependency, lockfile or
`package.json` change. No acceptance criterion moves from this slice; AC-006, AC-009, AC-010 and AC-014
remain NOT RUN.

## Defects found

1. **The file-backed fake serialised only within one instance.** `FakeSupplier` held an in-process promise
   chain, so two independent instances, or two processes, performed overlapping read-modify-write cycles on
   the same ledger path. Racing submissions of one external client reference each minted their own
   `syn-<uuid>` external order, and the last atomic replace discarded the others. A worker could therefore
   hold an acknowledgement for an external order the ledger no longer contained.
2. **On Windows the race was not merely lossy, it failed.** Concurrent `rename` onto the same destination
   returned `EPERM`, so a competing instance crashed instead of writing. Under the worker this surfaces as a
   submission exception, which is fail-closed but indistinguishable from a lost connection.
3. **A stale not-found lookup could demote a live submission.** `reconcile` read the intent state in one
   transaction, released it, looked up, and then wrote `human_review` for any intent still in `submitting`
   or `outcome_unknown`. A reconciliation pass that looked up *before* another worker's send reached the
   supplier therefore escalated an attempt that was still in flight, using evidence that predated it.
4. **An overtaken worker reported and published a contradicted outcome.** When a competing worker
   acknowledged an intent while this worker's own send was failing, the guarded `UPDATE` correctly changed
   nothing, but the method still returned `outcome_unknown` and still inserted an `OrderOutcomeUnknown`
   outbox row for an intent that was already `acknowledged`. Outbox rows are committed facts, so this
   published a false one.
5. **The new bounded wait was not actually bounded** — a defect in the first implementation of this slice,
   raised by coordinator review and corrected here. `lockWaitMs` was used unvalidated, so `NaN` produced a
   `NaN` deadline that `Date.now() >= deadline` never satisfies, and `Infinity` produced one that is never
   reached: either value turned the documented refusal into an unbounded spin. The deadline was also derived
   from the wall clock, so a clock change moving backwards extended the wait indefinitely. Both are fixed and
   covered by executed tests.

## Guarantees now implemented

### Synthetic ledger (`packages/supplier/src/fake.ts`)

- Every ledger read and every read-modify-write runs under an exclusive-create marker file
  (`<ledger>.lock`, `open` with `wx`), which is atomic across independent instances and separate processes.
  One external client reference therefore keeps one external order however many instances submit it, and
  concurrent submissions of distinct references cannot overwrite each other.
- Acquisition waits a bounded time (`lockWaitMs`, default 2000 ms, polled every `lockPollMs`, default
  10 ms) and then **refuses** with `SupplierLedgerLockError` (`code: 'SUPPLIER_LEDGER_LOCKED'`). There is no
  unbounded wait.
- **The bounds are validated in the constructor, before any filesystem access**, and an unusable value
  throws `RangeError`. Both must be whole milliseconds: `lockWaitMs` in `0..60000`, `lockPollMs` in
  `1..1000`. This rejects `NaN` and `±Infinity`, which previously produced a deadline that could never be
  reached, along with negative, fractional and absurdly large values. `lockWaitMs: 0` is legal and means
  refuse on the first contended attempt; `lockPollMs` may not be `0`, which would busy-spin.
- **Elapsed time is measured with `process.hrtime.bigint()`, not the wall clock**, so a system clock change
  cannot extend or shorten the wait. The wall-clock `acquiredAt` in the marker is diagnostic only and is
  never read to make a decision. The final sleep is clamped to the time remaining, so the total wait is at
  most `lockWaitMs` plus one acquisition attempt.
- **A marker is never broken on age.** A marker left by a crashed holder is not deleted after any timeout;
  the bounded wait ends in refusal so the evidence survives for an operator decision. Release deletes the
  marker only when the recorded owner matches this instance. The marker records owner, pid and acquisition
  time for diagnosis only; nothing reads that time to authorise a takeover.
- A refused operation performs no write, so the ledger stays byte-identical. `lookup` refuses rather than
  answering "not found" from a ledger it could not read.
- `ledger()` now takes the same exclusive access, so an observer cannot read a half-written file and cannot
  block a concurrent replace. The pause point used by tests is outside the lock, so an unfinished send does
  not hold the ledger against a competing lookup.
- Existing external-reference semantics are unchanged: `pc-syn-` prefix validation, positive decimal line
  quantities, `syn-<uuid>` external order identity, per-mode accepted/rejected split, and the
  `timeout_after_accept` throw after the ledger write.

### Worker transitions (`packages/db/src/orders.ts`)

- **`human_review` is reachable only from `outcome_unknown`.** A `submitting` intent is never escalated by a
  not-found lookup, because a send that has not finished cannot be described by a lookup that ran before it.
  Such a pass mutates nothing and reports the current durable state.
- **Version compare under lock.** The escalation re-reads the intent `FOR UPDATE` and applies only when the
  state is still `outcome_unknown` *and* the version is the one observed before the lookup. If anything moved,
  a competing worker owns the newer outcome and this pass makes no change.
- **No lost acknowledgement.** A failed send re-reads the intent `FOR UPDATE`; if a competing worker already
  settled it, the worker reports that durable outcome and records neither an unknown attempt outcome nor an
  `OrderOutcomeUnknown` event. The event is now emitted only when the transition actually occurs.
- **No duplicate submission.** Claiming still requires state `queued` under `FOR UPDATE` in the same
  transaction that writes `submitting` and the `submission_attempt` row, and `submission_attempt.intent_id`
  is unique. A second worker observes the claim and does not send.
- **One external order per intent.** Acknowledgement now refuses to overwrite a different
  `external_order_id` already recorded against the intent.
- Unknown outcomes keep their budget reservation, dispatch remains paused until
  `enableSyntheticDispatch()` has run, and a refused or unavailable lookup is inconclusive and mutates
  nothing.
- Receipt behaviour is unchanged; no defect was found there. `confirmReceipt` takes the intent `FOR UPDATE`
  before reading the prior receipt, so replays and concurrent attempts serialise on that row: one receipt
  identity, one writeback, and one budget release/spend. A line that exceeds shipped throws, and the caller's
  transaction rolls back the earlier lines in the same request. The new database test asserts these
  properties rather than assuming them.

## Evidence

### Executed now: synthetic ledger, no database

Command: `node --experimental-strip-types --test packages/supplier/test/fake-concurrency.test.ts`

RED, before `fake.ts` was changed — 4 tests, 0 pass, 4 fail:

- `independent instances submitting one reference converge on a single external order`:
  `EPERM: operation not permitted, rename '...ledger.json.<uuid>.tmp' -> '...ledger.json'`
- `concurrent submissions of distinct references all survive in one ledger`: same `EPERM` rename failure.
- `independent processes submitting one reference converge on a single external order`: child process exited
  1 with the same `EPERM` rename failure.
- `an unavailable ledger is refused within a bound, and evidence is never overwritten or broken`:
  `AssertionError [ERR_ASSERTION]: Missing expected rejection` — the submission succeeded although another
  holder owned the ledger.

The first three are genuine concurrency failures rather than clean assertion failures: on this platform the
unsynchronised replace aborts before the assertions are reached. The fourth is an assertion failure against
the refusal contract.

A second RED, for the unbounded-wait defect raised in coordinator review, was recorded against the first
implementation of the lock — 7 tests, 5 pass, 2 fail:

- `lock bounds that cannot bound a wait are refused before any ledger access`:
  `AssertionError [ERR_ASSERTION]: Missing expected exception (RangeError): expected {"lockWaitMs":null} to
  be refused at construction` — `NaN` was accepted as a wait bound.
- `a wall clock moving backwards cannot extend the bounded wait`: the child process never refused and was
  killed at the 15 s limit (`the bounded refusal never arrived: Command failed: ... clock-child.mjs`),
  which is the unbounded spin itself. The case runs in a child process precisely so an unbounded wait is
  killed and reported rather than hanging the suite.

GREEN, after both changes — 7 tests, 7 pass, 0 fail. The supplier suite has been run six times in total
across this slice with no flake; the clock case went from being killed at 15028 ms to refusing in 315 ms:

```
✔ independent instances submitting one reference converge on a single external order
✔ concurrent submissions of distinct references all survive in one ledger
✔ independent processes submitting one reference converge on a single external order
✔ a submission in flight does not block a competing lookup, which sees no order yet
✔ an unavailable ledger is refused within a bound, and evidence is never overwritten or broken
✔ lock bounds that cannot bound a wait are refused before any ledger access
✔ a wall clock moving backwards cannot extend the bounded wait
ℹ tests 7  ℹ pass 7  ℹ fail 0
```

The in-flight lookup case is a property guard for the lock boundary, not a reproduction of a defect: the
previous implementation would also have passed it. The multi-process case starts four separate `node`
processes against one synthetic temporary ledger and holds them at a file barrier until all four are ready,
so the submissions genuinely overlap. The clock case replaces `Date.now` in a child process with a clock
that moves an hour into the past on every reading.

Also executed: `npm run typecheck` (clean), `npm run lint` (clean), and `npm test` — 324 tests, 324 pass,
0 fail, unchanged from the recorded baseline. The new supplier test file is not in the coordinator-owned
`npm test` glob and was run explicitly.

### Awaiting the coordinator: PostgreSQL

`packages/db/test/order-recovery-concurrency.test.ts` has **not been run**. Per this task's constraints no
database test, migration, setup or Docker command was executed, and `pharmacart_test` was not touched. Its
RED and GREEN evidence awaits the coordinator's serialised run. Nothing below is a measured result.

The file is picked up by the existing `test:integration` and `test:coverage` globs
(`packages/db/test/*.test.ts`); no `package.json` change is needed. It resets the database per test and
seeds one extra verified pack, need and offer for the same supplier so an order has two lines; that seeding
is local to the test file and does not modify `procurement-fixture.ts` or `support.ts`. Six cases:

| Case | Asserts | Expected behaviour of the pre-change code |
| --- | --- | --- |
| A stale not-found lookup cannot demote a submission still in flight | the intent stays `submitting` at the same version with its reservation, and the paused send still acknowledges | FAIL: escalated to `human_review` |
| A worker overtaken during an uncertain send reports the durable outcome | the overtaken `run` returns `acknowledged` and no `OrderOutcomeUnknown` event exists | FAIL: returned `outcome_unknown` and published the event |
| Competing workers claim and submit a queued intent exactly once | one submit call, one attempt row, one external order matching the durable record | expected to pass; regression guard |
| A refused supplier ledger keeps the intent queued, reserved and unsubmitted | a foreign lock marker forces refusal; no attempt row, state stays `queued`, dispatch resumes after the marker is cleared | FAIL: the old fake ignored the marker and submitted |
| A settled unknown outcome with no supplier record escalates to human review exactly once | escalation still happens, is not rewritten on later passes, keeps the reservation and is never auto-dispatched | expected to pass; proves escalation was narrowed, not removed |
| A receipt failing on a later line leaves no partial stock, receipt, writeback or spend | the earlier line's `received` rolls back; the corrected receipt confirmed three times concurrently yields one receipt, one writeback and one settlement (`0.00/22.35` of a `39.70` reservation) | expected to pass; verifies existing receipt behaviour |

Competing workers are orchestrated with a supplier that pauses a submission either before or after the
ledger write, so a second worker acts while the first attempt is genuinely unfinished. The tests assert the
durable record, the outbox and the synthetic ledger, not the internal steps.

`packages/db/test/supplier.test.ts` is unowned by this task and was not edited. Tracing it against the new
code, its assertions should still hold, including the `outcome_unknown` return when a lookup is unavailable
and the acknowledged state after `pg_restore`. That expectation has not been executed and must be confirmed
by the coordinator's run.

## Limitations and the real-vendor boundary

- **Everything here is synthetic.** No real supplier, network transport, credential or external writeback is
  involved. The ledger is a local JSON file and the worker is still a one-shot runner, not a durable
  scheduler.
- **Filesystem locking is not a distributed lock.** It protects instances sharing one filesystem path. It
  does not survive a network filesystem with weak `O_EXCL` semantics and is not a model for a real supplier
  API, which provides idempotency and lookup over a transport instead.
- **The acquisition maxima are policy, not physics.** A caller cannot configure a wait longer than 60 s or a
  poll slower than 1 s. These values were chosen so a refusal stays distinguishable from a hang in a
  synthetic one-shot worker; a real transport with its own retry policy would need different limits, set
  deliberately rather than inherited from here.
- **The monotonic guarantee is tested by clock substitution, not by a real clock change.** The executed test
  replaces `Date.now` in a child process. It proves the implementation does not derive its deadline from that
  source; it does not exercise an operating-system time step, NTP slew or suspend/resume.
- **A crashed holder needs an operator.** Because a marker is never broken on age, a process that dies
  holding the ledger leaves every later access refused until the marker is removed. That is deliberate
  fail-closed behaviour, and it means the synthetic supplier can become unavailable until someone acts. No
  automatic recovery for this exists, and none should be added on a timeout alone.
- **An unfinished send is not recoverable across processes.** Because `submitting` is never escalated from a
  not-found lookup, an intent whose owning process died mid-send stays `submitting` and is never
  automatically dispatched or escalated. This is fail-closed and preserves the reservation, but it requires
  human reconciliation. Distinguishing a dead sender from a live one needs a lease or heartbeat that this
  slice deliberately does not invent.
- **The worker's return value is a verdict about the attempt, not always the durable state.** When a lookup
  is unavailable, `reconcile` reports `outcome_unknown` while the row may still be `queued`. This preserves
  existing behaviour that `supplier.test.ts` depends on. The API read model reports the durable state, so the
  user-visible uncertainty block is unaffected.
- **The authoritative-not-found rule is still undefined.** Contract foundation open decision 5 remains open:
  until an adapter is certified, no `not_found` result may authorise a retry. Nothing in this slice
  introduces automatic resubmission, and `human_review` still requires authorised human reconciliation to
  leave.
- Whether partial rejection should release a proportional reservation before terminal reconciliation
  (open decision 10) is unchanged and untouched here.
