# Receipt writeback

Receipt writeback delivers a confirmed receipt to a pharmacy stock system at most once and records proof
that it arrived. Everything here is synthetic: the only stock system is a local file-backed fake, and no real
pharmacy system, supplier, credential or paid service is contacted.

Review findings and the regression tests behind this design are in
[testing/synthetic-writeback.md](testing/synthetic-writeback.md).

## Boundary: delivered is not included

`receipt_writeback.status = 'applied'` and `receipt_writeback_attempt.sink_receipt_token` prove that the
stock sink recorded the receipt. They do **not** prove that any later inventory snapshot, projection or
watermark contains the received stock. That is the release gate's rule (RELEASE-GATE.md), and migration
0014 records inclusion in separate columns for exactly this reason.

- Writeback never writes the inclusion columns on `receipt_writeback`. They stay NULL. A separate inclusion
  writer sets them later from a feed snapshot, once a feed persistence sink exists.
- The only write writeback makes to `receipt_writeback` is `status` from `queued` to `applied`. It writes
  nothing to need, inventory, alert, order or receipt tables.
- Anything asking "is this receipt visible in stock yet?" must answer from inclusion evidence, never from
  `applied`. Reading `applied` as inclusion would release replenishment holds for stock no snapshot has
  counted.

`packages/writeback/test/inclusion-boundary.test.ts` fails if a writeback source names an inclusion column
or writes anything to `receipt_writeback` other than the status. The database suite also asserts the
columns stay NULL after real deliveries.

## Components

| File | Role |
| --- | --- |
| `packages/writeback/src/payload.ts` | Payload shape and validation; stable sink key, payload hash, stock receipt token |
| `packages/writeback/src/sink.ts` | File-backed synthetic stock ledger, independent of PostgreSQL |
| `packages/writeback/src/synthetic-entry.ts` | The supported sink constructor; refuses any non-synthetic configuration |
| `packages/writeback/src/processor-policy.ts` | Processor bounds, the sink call deadline, failure classification |
| `packages/db/src/writeback.ts` | `WritebackProcessor`: claim, check, send, recover and settle under tenant scope |
| `packages/db/migrations/0018_writeback_attempts.sql` | `receipt_writeback_attempt` and the append-only `receipt_writeback_attempt_log` |

`confirmReceipt` in `packages/db/src/orders.ts` queues the `receipt_writeback` row. It is unchanged.

## Lifecycle

`receipt_writeback.status` stays `queued` or `applied`. In-flight state is `receipt_writeback_attempt.phase`:

```
(no attempt) or pending ──claim──▶ checking ──lookup not found──▶ submitting ──evidence──▶ applied
        ▲                            │                              │
        │                   lookup found ─────────────────────────────────────────────▶ applied
        │                   lookup inconclusive ──▶ pending (after retry delay)
        │                                                           │ no answer
        │                                                           ▼
        │                                                    outcome_unknown ──lookup found──▶ applied
        │                                                           │ lookup inconclusive: stays, retried after delay
        │                                                           │ not found, sink guarantees idempotency
        └───────────────────────────────────────────────────────────┘
                                                                    │ not found, no guarantee
                                                                    ▼
                                                            needs_reconciliation (operator)
```

The rules, each of which closes a defect found in review:

1. **Every send is preceded by a lookup under the same claim.** The claim commits phase `checking`, looks
   up, and only if the sink holds nothing commits `submitting` and sends. A restored database, a replayed
   queue row or a released attempt therefore never sends blindly. There is no process-wide startup pass to
   forget or to bound.
2. **A lease identifies one claim, not one worker.** Every claim mints a `lease_token`. Only the holder of the
   current token may move an attempt to any non-applied phase. A live lease is never disturbed, whether the
   competitor is another worker or a concurrent call in the same worker.
3. **A send that may have happened is only settled by lookup.** `submitting` and `outcome_unknown` never
   send. "Not found" permits a further attempt only when the sink explicitly guarantees idempotent apply,
   and that attempt still goes through `checking`. Otherwise the writeback is held.
4. **Positive matching evidence is authoritative whoever holds the lease.** A send overtaken by lease
   expiry that lands later is recorded as applied rather than discarded. Holds remain reserved to the current
   claim.
5. **Everything is bounded.** Each sink call runs under `sinkCallTimeoutMs`, which must be at most half of
   `leaseMs`, and the lease is extended before each call. Each database lock wait is bounded by
   `lockTimeoutMs`. A released attempt waits `retryDelayMs`. Each claim counts an attempt; exceeding
   `maxAttempts` holds the writeback. One run processes each writeback at most once.
6. **Every sink call is recorded** in `receipt_writeback_attempt_log`, append-only for the runtime role, in
   the same transaction that settles it. A settlement that rolls back leaves the attempt in its last
   committed phase, which never understates a send.
7. **One lock order.** Every transaction locks the `receipt_writeback` row before its attempt row, so claims
   and settlements cannot deadlock. A database lock timeout, deadlock or serialisation failure is returned
   as a named refusal, not thrown.
8. **A writeback the processor cannot describe is held**, with `payload_unbuildable`, so one bad row never
   blocks the queue behind it.

### Hold reasons

| Reason | Meaning |
| --- | --- |
| `attempts_exhausted` | The bounded attempt count ran out |
| `payload_unbuildable` | The receipt cannot be described exactly (missing snapshot, non-canonical quantity, invalid identity) |
| `payload_changed` | The durable receipt no longer matches the payload the attempt recorded |
| `receipt_changed_during_call` | The receipt changed while the sink was being called |
| `sink_key_changed` | The derived stock receipt key differs from the recorded one |
| `attempt_status_disagree` | The attempt records applied while the writeback is still queued |
| `evidence_mismatch` | The sink returned evidence for a different key, payload or line count |
| `sink_receipt_conflict`, `sink_ledger_corrupt`, `sink_ledger_too_large`, `payload_invalid` | The sink refused definitively |
| `not_found_without_idempotency` | A send may have happened, the sink holds nothing, and it does not guarantee idempotent apply |

## Tenant isolation

Both new tables force row-level security with the same `tenant_scope` policy as every tenant table, and are
written only through `withTransaction` under the runtime role. Migration 0018 adds
`UNIQUE(organisation_id, branch_id, id)` to `receipt_writeback` and references it with composite foreign
keys, because a foreign key on the id alone is checked with row security bypassed and would let one tenant
attach attempt rows to another tenant's writeback. The processor runs only for `pharmacy_owner` and
`receiver`, the roles that may confirm a receipt. SQL context is not authentication: the membership check in
`withTransaction` is.

## Usage

```ts
import { WritebackProcessor } from '../packages/db/src/writeback.ts';
import { openSyntheticStockSink, syntheticSinkAcknowledgement } from '../packages/writeback/src/synthetic-entry.ts';

const sink = openSyntheticStockSink({
  target: 'synthetic-file',
  acknowledgement: syntheticSinkAcknowledgement,
  ledgerPath: 'D:/synthetic/stock-ledger.json',
});
const processor = new WritebackProcessor(pool, { subject, organisationId, branchId }, sink, { batch: 25 });

const run = await processor.runOnce();
if (run.kind === 'stopped') report(run.reason, run.detail); // forbidden, database_lock_timeout, database_conflict
for (const outcome of run.outcomes) {
  switch (outcome.kind) {
    case 'applied': break;                                    // delivered; NOT included in stock
    case 'queued': if (outcome.phase === 'needs_reconciliation') alertOperator(outcome.reason); break;
    case 'refused': break;                                    // named database or scope refusal
  }
}
```

`process(writebackId)` handles one addressed writeback and returns a single `WritebackOutcome`.

## Not done

- **No operator surface.** Held writebacks accumulate in `needs_reconciliation` with a reason and a log, but
  nothing lists or resolves them.
- **No runtime wiring.** No worker command, schedule or durable runner calls the processor.
- **The sink is a fake.** The processor's evidence check and the `sink_key` and `sink_receipt_token` column
  formats are specific to the synthetic token scheme; a real adapter needs its own evidence contract.
- **Exhaustion does not look up first.** An attempt that runs out while `outcome_unknown` is held without a
  final lookup. That is conservative but may hold a receipt the sink already has.
- **Inclusion is not implemented** and is deliberately out of scope.
