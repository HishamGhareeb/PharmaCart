# Synthetic alert delivery (persistence, dispatch and sink)

Branch `claude/alert-delivery`, base `cd4bb7e`. Integrates the isolated `claude/synthetic-alert-delivery`
lane (base `9584ace`, never merged) after an adversarial review, and fixes what that review found.
Status: pure layer implemented and run; database layer implemented and **never executed**.
AC-017 remains **NOT RUN**.

The lane's `synthetic-alert-delivery-red.txt` and `-green.txt` were produced on a different base and are
not carried forward. Current RED and GREEN evidence is the coordinator's to produce.

## 1. What changed from the lane

| File | From the lane | Changed in integration |
| --- | --- | --- |
| `packages/notifications/src/instant.ts` | verbatim | - |
| `packages/notifications/src/policy.ts` | verbatim | - |
| `packages/notifications/src/sink.ts` | adapted | Windows EPERM marker contention waited out within the bound (S1) |
| `packages/notifications/src/payload.ts` | rewritten | allowlist of redacted templates derived from `packages/alerting` replaces the substring denylist (P1, P2) |
| `packages/notifications/src/acceptance.ts` | adapted | plans over the open episode read from the database instead of a persisted JSON state (E1, E2); `planEpisodeResolution`; named `invalid_deferral_count` |
| `packages/notifications/src/dispatch.ts` | **new** | lease eligibility, reconciliation and pre-send lookup plans, bounded options, `callWithin` deadline (C1, C2, D1, R1, R2, L1) |
| `packages/notifications/src/index.ts` | adapted | exports |
| `packages/db/src/notifications.ts` | rewritten | see findings; adds `resolveAlertEpisode` |
| `packages/db/migrations/0019_notification_delivery.sql` | renumbered from `0016`, reshaped | no JSON state; one-open-episode index; tenant-bound composite keys; attempt table with one-send index; payload allowlist; lease invariant; column-level UPDATE grants |
| `packages/notifications/test/*.test.ts` | adapted, plus `dispatch.test.ts` | regression tests for every pure finding |
| `packages/db/test/notifications.test.ts` | 14 lane tests adapted, 15 new | regression tests for every database finding |

Migrations 0013 to 0015 did not exist when the lane was written. None of them touches a table this migration
references; `connector_installation(id,organisation_id,branch_id)` uniqueness (0004), `branch.timezone`
(0001), `pharmacart_current_organisation_id()` (0001) and the lifecycle function (0011) are unchanged at
`cd4bb7e`. Numbers 0016 to 0018 are reserved for other builders; nothing in the tree referred to the old name.

## 2. Review findings

Every finding except B1, B2 and X1 has a regression test written before its fix; B1, B2 and X1 were fixed without a
dedicated test and are covered only indirectly. Pure tests were run here before the fix and failed, at module load,
against the lane's API (P1 and P2 were additionally reproduced by calling the lane's own `payload.ts`). Database tests
have not been run by anyone.

### Duplicate push

- **D1 - a restored database replays a delivered alert.** The lane looked up only rows with `attempts > 0`.
  No update ever returned a row to `pending`, so that branch was dead, and a `pending` row restored from a
  backup taken before its delivery was sent without asking the sink. The synthetic sink is idempotent and hid
  it; a push provider without idempotent accept would notify twice. **Fix:** every first send is preceded by a
  lookup (`planPreSendLookup`); `found` settles the row with the sink's receipt.
  Test: *a restored pending delivery the sink already holds is settled by lookup, not sent again*.
- **E1 - coalescing held only in memory.** "One open episode per condition" lived in a JSON document on
  `notification_alert_state`; `notification_episode` accepted a second open episode for the same condition.
  **Fix:** the document is gone. A partial unique index `notification_episode_one_open` makes it a database fact,
  the planner reads the open episode row `FOR UPDATE`, and `notification_delivery_attempt_one_send` makes a second
  send for one delivery uncommittable. Tests: *the database refuses a second open episode for one condition*;
  *concurrent first signals for one new condition coalesce into one episode in the database*; *a delivered
  notification can never be re-queued* (now also asserts the one-send index).

### Concurrency and restart

- **C1 - recovery demoted a live send.** `recoverAfterRestart` looked up every `dispatching` row whatever its
  lease. A second worker starting while the first was mid-send got not-found, moved the row to
  `outcome_unknown` and, on its next pass, to `manual_review`. With a timeout-after-accept the delivered alert then
  sat in `manual_review`, where an operator could resend it. The lease was written and never read. **Fix:**
  `reconciliationEligibility` skips a `dispatching` row whose lease is live and reports it as `leased`, which keeps
  the recovering worker paused. The sender bumps the row version in the committed transaction that authorises the
  send, so a reconciler that decided against the claim version cannot move it afterwards.
  Test: *a recovering worker leaves a delivery with a live lease alone and stays paused*.
- **C2 - an abandoned claim was never delivered.** A worker that died after claiming but before sending left the
  row `dispatching`; the lane escalated it to `manual_review` after two passes although nothing was ever sent.
  **Fix:** an expired claim with no recorded send attempt and a not-found lookup is released to `pending`
  (`claim_abandoned`). An expired claim *with* a recorded send becomes `outcome_unknown` and then
  `manual_review`, never a resend. Tests: *an abandoned claim that never sent is released after its lease and
  delivered once*; *an expired send with no sink record becomes unknown, then manual review, and is never resent*.
- **L1 - unbounded lock waits.** Neither acceptance nor the dispatcher set a lock timeout, so the per-installation
  `FOR UPDATE` waited forever behind a stuck transaction. **Fix:** every transaction sets `lock_timeout`
  (`lockTimeoutMs`, 1-30000, default 5000); expiry surfaces as `NotificationError('LOCK_TIMEOUT')` and writes
  nothing. Test: *acceptance waits a bounded time for the installation lock and writes nothing when it expires*.

### Unknown outcome and bounded retries

- **R1 - failed lookups retried forever, unrecorded.** An `outcome_unknown` row whose lookup kept failing was
  asked again on every pass indefinitely, and nothing recorded how often. **Fix:** every sink call is a row in
  `notification_delivery_attempt`; after `MAX_LOOKUP_FAILURES` (8) failed or timed-out lookups the row goes to
  `manual_review` (`lookup_attempts_exhausted`). Test: *failed lookups are recorded and bounded, then escalated for
  a person*.
- **R2 - the sink was awaited with no deadline.** A provider that never answered held the worker forever, and the
  lease meant to describe the attempt expired underneath it. **Fix:** `callWithin` bounds every lookup and send
  (`sinkTimeoutMs`, 1-60000, default 5000), and the options refuse a lease not longer than two sink deadlines. A
  timed-out send is recorded as `timed_out` and the row becomes `outcome_unknown`. Test: *a sink that never answers
  is abandoned within its bound and the attempt is recorded*.
- **B2 - index order.** The second review noted that the two partial outbox indexes covered `deliver_at` while the
  claim and recovery queries order by `deliver_at, id`. Both indexes now include `id`. Performance only.
- **B1 - unbounded recovery scan.** Recovery selected every unsettled row with no limit. It now processes one batch
  and reports `more: true`, which keeps dispatch paused until a later pass reaches the rest.
- **S1 - the synthetic sink failed under contention on Windows.** Found when the pure suite, green before, failed
  once. `SyntheticFileDeliverySink` treated only `EEXIST` from the exclusive marker create as contention; on Windows a
  create racing the previous holder's unlink reports `EPERM`, which was rethrown. The dispatcher reads that as a
  failed send, so the row went `outcome_unknown` then `manual_review` and the alert was never delivered. The lane's
  `concurrent deliveries` test failed 3 of 40 isolated runs. **Fix:** on `win32`, `EPERM` is waited out within the
  same `lockWaitMs` bound. Test: *heavy contention on one ledger is waited out rather than failing a delivery* -
  RED 10 of 10 runs before the fix (`EPERM ... sink.json.lock`), GREEN 10 of 10 after. `packages/supplier/src/fake.ts`
  has the identical check and is out of this slice's scope; reported, not changed.
- **X1 - receipts were trusted.** A receipt for a different delivery identifier, or with an empty identifier, settled
  the row. It is now treated as a failed lookup, or as an unknown send outcome (`invalid_receipt`).

### Privacy

- **P1 - the payload check was a denylist.** `sealDeliveryPayload` refused only strings the caller listed, at least
  three characters long, and the database constraint allowed any title or body within a length. A quantity, a branch
  name or product text not in the list reached the provider. **Fix:** the title must be one of the redacted titles
  and the body the fixed instruction, both read from `packages/alerting` at module load by running the reducer on a
  signal that carries nothing, so the allowlist cannot drift from the reducer. The outbox `CHECK` restates the same
  templates, so a drifted template fails closed. Tests: payload unit tests; *the outbox constraint refuses anything
  but a redacted template naming its own identity*.
- **P2 - the denylist lost alerts.** It scanned the serialised payload, including the fixed template and random
  UUIDs. A product called `PharmaCart` or `Stock`, a detail containing `review`, or a code such as `0000` that occurs
  in a UUID refused the payload, and the throw rolled back the whole acceptance. Reproduced against the lane's own
  `payload.ts`. **Fix:** P1's allowlist has no false positives by construction. Test: *signal text that happens to
  occur in the fixed template does not lose the alert*.
- **P3 - a JSON null passed the payload constraint.** `payload->>'episodeId' = episode_id::text` is NULL for a
  JSON null, and a `CHECK` that evaluates to NULL passes. **Fix:** every field must be a JSON string and the whole
  expression is coalesced to false. Covered by the constraint test above.

`packages/alerting` redaction is not bypassed: the payload is still built by the reducer, delivery forwards only its
two strings, and the dispatcher sends the stored payload the constraint has already checked.

### Tenant isolation

- **T1 - foreign keys named another tenant's rows.** A foreign key check ignores row level security. The lane's
  `notification_signal.episode_id` and `notification_outbox.episode_id` referenced `notification_episode(id)` alone,
  so a writer in tenant A could attach a signal to tenant B's episode, or occupy B's one outbox slot, by naming its
  identifier, and could probe whether an identifier existed. **Fix:** composite keys on
  `(id, installation_id, organisation_id, branch_id)` for episodes, outbox rows and attempts. Test: *a writer in one
  tenant cannot attach evidence to another tenant episode or delivery*.
- **G1 - table-wide UPDATE for the runtime.** Found by the second, independent review of this integration. The runtime
  held UPDATE on every column of `notification_outbox`, `notification_episode` and `notification_alert_state`, so a
  request path defect could re-point a delivery at another episode or rewrite its payload or severity (the payload
  `CHECK` would still have held the templates). **Fix:** column-level UPDATE on exactly the columns
  `packages/db/src/notifications.ts` writes, checked against every UPDATE in it: outbox `status, deliver_at, deferrals,
  version, lease_expires_at, settled_at, last_reason, receipt_id`; episode `severity, last_signal_at, signal_count,
  status, resolved_at`; lock row `episode_sequence`. Test: *the runtime login may update only the columns delivery
  writes*.
- RLS itself was sound in the lane. The integration test now checks all six tables from one tenant's scope and that a
  branch-A update of a branch-B row changes nothing.

### Episode lifetime

- **E2 - capacity counted history and nothing ever closed.** The lane bounded the JSON document at 2000 episodes,
  counted resolved ones, never removed any, and had no resolution path. Every episode stayed open, every recurrence
  coalesced silently, and after 2000 distinct conditions an installation refused every new shortage for good.
  **Fix:** the bound is 2000 *open* episodes (`MAX_OPEN_EPISODES_PER_INSTALLATION`), and `resolveAlertEpisode`
  closes an episode through the reducer so a recurrence opens a new one with its own delivery. Tests: pure planning
  tests; *resolving a condition lets it open a new episode, and only open episodes occupy capacity*.

### Defects in the lane's own tests

Two lane integration assertions could not have passed against the lane's code: the first test expected four
`notification_signal` rows where three identities were accepted, and the malformed-signal test expected a
`notification_alert_state` row that the refusal's rollback removes. Both are corrected here. Nothing else in the
lane had been run against PostgreSQL either.

## 3. Defects in `packages/alerting` - reported, not fixed

That package is outside this slice. None of these is reachable through delivery as integrated, because delivery
validates first or does not persist the value, but each would bite a future caller.

1. `isWithinQuietHours` returns `false` - "not quiet" - for an invalid window, an unknown time zone or an unparseable
   instant. Anyone using it to decide whether to deliver fails open at night. Delivery does not call it.
2. `applyAlertSignal` accepts any `observedAt` that `new Date` parses (`'2026'`, locale dates), and so does
   `scheduleDelivery`. `validateAlertSignal` refuses these before the reducer sees them.
3. Coalescing sets `lastSignalAt` to the incoming `observedAt` unconditionally, so a late, older signal moves it
   backwards. Delivery persists the reducer's value as it is.
4. `resolveAlertCondition` overwrites `lastSignalAt` with the resolution instant, conflating two facts. Delivery stores
   the resolution in `resolved_at` and does not persist that overwrite.
5. The quiet-hours window validator accepts minute 1440, which no local minute equals. `resolveNotificationPolicy`
   refuses it.
6. The redacted titles and body are module-private. Delivery derives them by running the reducer; exporting them would
   remove that indirection and the restated strings in the migration's `CHECK`.

## 4. Behaviour now

**Acceptance** (`acceptAlertSignal`): bounded lock wait; installation from the authenticated subject and its lifecycle;
signal validated before any write; per-installation row `FOR UPDATE`, lifecycle re-checked after the wait; identity
against `notification_signal` (duplicate or `CONFLICTING_SIGNAL`); open episode for the condition read `FOR UPDATE`;
policy from `notification_policy` and `branch.timezone`; the reducer decides; episode, signal, sequence and outbox row
commit together. An unusable policy opens the episode with `suppressed_reason` and schedules nothing.

**Dispatch** (`NotificationDispatcher`): paused until `recoverAfterRestart` finds no unresolved row, no live lease and no
further batch. Each `dispatchDue` pass reconciles eligible unsettled rows, then claims due `pending` rows with
`FOR UPDATE SKIP LOCKED`, re-evaluates quiet hours (defer, bounded at eight; hold on unusable policy), and for each claim
runs, with no transaction open: lookup, then a committed transaction that records it, bumps the version and inserts the
send attempt, then the send, then a transaction that records its outcome. Every transition is guarded by the version it
was decided against.

| Row | Lookup | Result |
| --- | --- | --- |
| claimed, before send | found | `delivered` with the sink's receipt |
| claimed, before send | not found | send |
| claimed, before send | failed | back to `pending`; `manual_review` after 8 failures |
| `dispatching`, lease live | not asked | left alone, counted as `leased` |
| `dispatching`, lease expired, no send recorded | not found | back to `pending` |
| `dispatching`, lease expired, send recorded | not found | `outcome_unknown`, send attempt `abandoned` |
| `outcome_unknown` | not found | `manual_review` |
| any unsettled | found | `delivered` |
| any unsettled | failed | recorded; `manual_review` after 8 failures |

## 5. Tests and commands

### Pure, run here

```
node --experimental-strip-types --test packages/notifications/test/*.test.ts
```

Files: `acceptance.test.ts`, `dispatch.test.ts` (new), `payload.test.ts`, `policy.test.ts`, `sink.test.ts`. The lane's
73 tests were first run unchanged on `cd4bb7e` (73 pass). With the new and adapted tests in place and no source changed,
all four changed files failed to load (missing `dispatch.ts`, missing exports, the removed denylist parameter). After
the implementation: 101 tests, 101 pass, 0 fail. S1 was found afterwards (section 2); with its test added:
102 tests, 102 pass, 0 fail, on three consecutive runs. `sink.test.ts` spawns four child `node` processes against a temporary
synthetic ledger.

### Database, not run - coordinator only

```
node --experimental-strip-types --test --test-concurrency=1 packages/db/test/notifications.test.ts
```

It is also picked up by the existing `npm run test:integration` and `test:coverage` globs. It resets
`pharmacart_test` per test and needs migration 0019 applied by that reset. 29 tests:

| Test | Kind |
| --- | --- |
| repeated and concurrent signals produce one episode and one notification | guard (lane test, corrected count) |
| concurrent first signals for one new condition coalesce into one episode in the database | guard |
| the database refuses a second open episode for one condition | regression E1 |
| a changed payload under a reused signal identity is refused and writes nothing | guard |
| resolving a condition lets it open a new episode, and only open episodes occupy capacity | regression E2 |
| quiet hours follow the branch time zone and the stored policy, not the server clock | guard |
| a deferred delivery survives a restart and fires exactly once at the scheduled instant | guard (durable deferral) |
| a delivery that comes due inside the quiet window is re-deferred rather than sent | guard |
| an unusable policy records the episode and never schedules an immediate delivery | guard |
| an accepted delivery whose answer is lost is resolved by lookup, not by sending again | guard (unknown outcome) |
| a recovering worker leaves a delivery with a live lease alone and stays paused | regression C1 |
| an abandoned claim that never sent is released after its lease and delivered once | regression C2 |
| an expired send with no sink record becomes unknown, then manual review, and is never resent | guard |
| a restored pending delivery the sink already holds is settled by lookup, not sent again | regression D1 |
| a sink that never answers is abandoned within its bound and the attempt is recorded | regression R2 |
| failed lookups are recorded and bounded, then escalated for a person | regression R1 |
| dispatch stays paused while an unsettled delivery cannot be reconciled | guard |
| the delivery payload carries no product, branch or quantity detail | guard |
| the outbox constraint refuses anything but a redacted template naming its own identity | regression P1, P3 |
| signal text that happens to occur in the fixed template does not lose the alert | regression P2 |
| one tenant cannot see or deliver another tenant notification | guard |
| a writer in one tenant cannot attach evidence to another tenant episode or delivery | regression T1 |
| a revoked installation cannot accept or resolve an alert | guard |
| the runtime login cannot write policy, delete evidence or rewrite a recorded attempt | guard |
| the runtime login may update only the columns delivery writes | regression G1 |
| a delivered notification can never be re-queued | guard, plus one-send index |
| acceptance waits a bounded time for the installation lock and writes nothing when it expires | regression L1 |
| malformed and oversized signals are refused before anything is written | guard (lane test, corrected) |
| a synthetic sink is refused unless the caller acknowledges it | guard |

Expected against the lane's code: every regression row fails, and the lane's migration cannot satisfy the tests that
reference `notification_delivery_attempt`, `resolved_at` or `episode_sequence`.

### Required root `package.json` change (coordinator)

`npm test` and `npm run test:coverage` enumerate packages explicitly. Both need `packages/notifications/test/*.test.ts`
added; until then the 102 pure tests run only by hand. No glob change is needed for the database test.

Also run here on this worktree: `npm run typecheck` (exit 0) and `npm run lint` (exit 0). `npm test` and the coverage
gate were not run.

## 6. Limitations and deployment blockers

- **Nothing reaches a device.** The only sink is `SyntheticFileDeliverySink` (`kind: 'synthetic'`), refused unless the
  caller passes `allowSyntheticSink`. There is no default sink.
- **The database layer has never executed.** Expect defects in SQL the review could not exercise.
- **A lookup's not-found is treated as authoritative before a first send.** That is what protects a restored database,
  and it is only as good as the provider's lookup. A provider whose lookup lags acceptance could still be sent a
  duplicate after a restore. A real adapter needs certified lookup semantics before this rule is trusted; this matches
  the order path's open decision on authoritative not-found.
- **Known behaviour, not a defect: a crash after authorising a send is escalated even if nothing was sent.** A worker
  that dies between committing the send attempt and calling `sink.deliver` leaves a recorded send with no outcome.
  After the lease expires recovery finds nothing at the sink and moves the row to `outcome_unknown`, then
  `manual_review`, although the sink never saw the request. This is the deliberate price of never resending: from the
  database alone a send that was authorised cannot be told apart from one that reached the provider and was lost.
- **A timed-out call is not cancelled.** A send abandoned at its deadline may still land. That is why the row becomes
  `outcome_unknown` and is never resent, and why the lease must exceed two sink deadlines. Deadlines use real time,
  leases the injected clock; a deployment must keep them consistent.
- **No scheduler, no operator surface.** `dispatchDue` is a single pass someone must call; `held` and `manual_review`
  rows have no release path, no screen and no alert on their existence. An unusable policy at acceptance suppresses the
  episode's delivery permanently for as long as it stays open.
- **Nothing calls `acceptAlertSignal` or `resolveAlertEpisode` yet.** The inventory path still writes `inventory_alert`
  and is another lane's file. A caller must derive `signalId` from the inventory event identity so a replay is a
  duplicate, and `conditionKey` as `installationId:sourceCode`.
- **Recipients, rate limits and retention are not modelled.** The payload names an installation, not a person. Episodes,
  signals, outbox rows and attempts accumulate.
- **Severity escalation inside an open episode still does not re-deliver**, which remains the product decision
  `docs/alerting.md` declined to invent.
- `notification_policy` must be seeded; without a row every signal is suppressed with `policy_missing`.

## 7. AC-017

Still **NOT RUN**. The criterion needs a notification test with a controllable clock and time zone and a fake delivery
sink, retaining episode count, scheduled delivery and redacted payload assertions. Those assertions now exist against the
real persistence path, but they have not been executed, and lock-screen redaction cannot be complete while no client
renders a notification.

## Coordinator verification

Run by the coordinator, the single database test runner, on this worktree at base `cd4bb7e`, against a freshly dropped and recreated `pharmacart_test` so no other lane's migration could affect the schema. The builder ran the pure suite and was barred from running any database test.

RED at the module boundary, with `packages/db/src/notifications.ts` moved aside and then restored:

```
$ node --experimental-strip-types --test --test-concurrency=1 packages/db/test/notifications.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/db/src/notifications.ts'
```

The builder recorded behavioural RED for every finding except B1, B2 and X1, each written against the lane's code before its fix, including the S1 file-sink lock race failing 10 of 10 stress runs before the fix.

GREEN:

| Command | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `node --experimental-strip-types --test packages/notifications/test/*.test.ts` | 102 | 102 | 0 |
| `node --experimental-strip-types --test --test-concurrency=1 packages/db/test/notifications.test.ts` | 29 | 29 | 0 |
| `npm run typecheck`, `npm run lint` | | pass | |

## Coordinator review notes

**The least-privilege finding is resolved.** The runtime role holds column-level UPDATE on all four mutable tables. On `notification_outbox`, `payload`, `episode_id` and `severity` are unwritable, which matters because outbox severity decides whether a delivery bypasses quiet hours. On `notification_episode`, `severity` stays writable because an episode legitimately escalates while it is open; `condition_key`, `episode_ref` and `opened_at` are not.

**Defects reported in `packages/alerting` are queued, not fixed here.** `isWithinQuietHours` fails open on bad input, the reducer accepts partial dates such as `2026`, a late signal can move `lastSignalAt` backwards, resolution overwrites `lastSignalAt`, the window validator accepts start minute 1440, and the redacted templates are private so the migration restates them. Delivery validates before the reducer or does not persist the affected values, so none is reachable through this lane, but they belong in a follow-up against that package. The same Windows EPERM lock race fixed here in the file sink also exists in `packages/supplier/src/fake.ts`.

**Integration needs `packages/notifications/test/*.test.ts` added to the root `test` and `test:coverage` scripts.**
