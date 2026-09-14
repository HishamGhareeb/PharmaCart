# PharmaCart transactional feed persistence sink (B4)

Status: implemented; pure policy and worker configuration tests written and run locally, PostgreSQL tests written and awaiting the coordinator's run
Scope: persisting one guarded single-file feed pass, identity claim included, in one transaction per installation
Source input: docs/feed-identity.md, docs/feed-ingestion.md, docs/installation-lifecycle.md, migration 0013; acceptance criteria AC-003, AC-013 and AC-016 at the feed edge

`packages/db/src/feed-sink.ts` implements the `FeedSnapshotSink` boundary that `apps/worker/src/feed-worker.ts` has declared since the worker was integrated. Until now nothing implemented it, so a guarded pass could read and adapt a file but never land it.

## 1. One transaction, in a fixed order

`createFeedSnapshotSink({ pool, installationSubject, lockTimeoutMs?, afterProjectionAdvanced? })` returns `persist`, which answers with a discriminated outcome, and `ingest`, which is the worker contract and throws `FeedSinkRefusalError` with the refusal's name as `code`. Each call runs one transaction:

1. `SET LOCAL ROLE pharmacart_runtime` and a transaction-local `lock_timeout`.
2. Authorise the subject for `submit_inventory` through `loadInstallation` and `refuseInstallation`, the same lifecycle enforcement the API inventory path uses.
3. Take the per-installation `inventory_state` row lock, then authorise again, because a status change may have committed while the pass queued.
4. Read the accepted-sequence watermark: the later of the locked reducer checkpoint's latest sequence and the highest second in `feed_sequence_identity`.
5. Derive the envelope with `deriveSnapshotEnvelope`, passing that watermark.
6. Read the claims already recorded at the derived second and classify the submission.
7. Run the partition event and its single-file completion event through `applyInventorySnapshotEvent` in memory.
8. Only then write: the identity row if the second was unclaimed, inbox rows for accepted events, the reducer checkpoint and the projection.

Every refusal is decided before the first write and rolls back. Nothing partial survives a refusal, a lock timeout or an unexpected error.

## 2. What a claimed second means

Migration 0013 records what each installation accepted at each whole-second sequence. `classifySequenceClaim` compares the submission with those claims:

| Existing claim at the second | Outcome |
| --- | --- |
| none | unclaimed: record it and proceed |
| same batch key, partition key and content digest | replay: proceed so the reducer reports the duplicate |
| same batch key and partition key, different digest | `changed_content_same_sequence` |
| same batch key, different partition key | `changed_partition_same_sequence` |
| different batch key, whatever the content | `changed_batch_same_sequence` |

The table comment groups everything that is not a replay under `changed_content_same_sequence`. The sink splits that into three names because a second export under another batch key is not changed content, and calling it that would repeat the mistake 0013 was written to fix: naming the wrong problem. A same-batch export with a different partition key is refused because this worker publishes one complete snapshot per file, so that second's snapshot is already complete.

Other refusals keep the names of the layer that made them: `pairing_incomplete`, `installation_suspended`, `installation_revoked` and `installation_unknown` from the lifecycle; `stale_export`, `invalid_exported_at`, `invalid_identity` and `empty_partition` from the envelope; the reducer's own reasons such as `invalid_event`; and `lock_timeout`.

## 3. Concurrency

Two passes for one installation serialise on the `inventory_state` row lock that the API inventory path already takes. The second pass reads the watermark and the claims only after the first has committed, so it sees either a duplicate or a named refusal. The identity table cannot carry the lock itself: the runtime holds SELECT and INSERT only, and PostgreSQL row locks require UPDATE.

Every lock wait is bounded by `lock_timeout`, 5 seconds by default and at most 60, validated when the sink is created. A wait that exceeds it returns `lock_timeout` and the connection goes back to the pool clean. There is no retry loop. A unique violation on `feed_sequence_identity` cannot arise while every writer holds the row lock; if one does, it propagates as a database error rather than being guessed around.

Reading the watermark before the lock would let an older pass queued behind a newer one clear the stale check. With the read inside the lock, that older pass is refused as `stale_export` at the sink. The PostgreSQL test pins that name, not the reducer's incidental `stale_sequence`.

## 4. No need recalculation, and the seam for it

The API path's `ingestInventory` derives needs and alerts inline. This sink does not, deliberately, because need reconciliation is owned by a parallel lane and joining them is a later integration step.

The join point is `afterProjectionAdvanced`. When supplied, it runs inside the accepting transaction, after the projection is rewritten, and only when the projection revision advanced. Whatever attaches sees the new stock and commits or rolls back with the snapshot. Nothing attaches today, and the one-shot entry point does not supply it.

## 5. Why the durable writes are composed here rather than calling `ingestInventory`

`ingestInventory` opens and commits its own transaction per event, and it always runs the inline need derivation. Neither fits: the partition, its completion and the identity claim must commit together, and the task forbids triggering need recalculation. Calling it twice would split the snapshot across two transactions.

The sink therefore reuses the pieces rather than the function: the same lifecycle helpers, the same lock and recheck protocol, the same reducer, and the same inbox, checkpoint and projection statements. It does not re-implement the reducer. The cost is that the persistence statements now exist in two places. Once need reconciliation lands, both paths should share one transaction-scoped `applyInventoryCommand(client, ...)` in `packages/db/src/inventory.ts`; that refactor was left out here because `inventory.ts` sits outside this lane and inside the need-reconciliation lane's likely change.

## 6. One-shot entry point

`apps/worker/src/feed-once.ts` runs one guarded pass with this sink:

```
node --env-file=infra/runtime.env apps/worker/src/feed-once.ts --manifest <file> --root <drop directory>
```

`parseFeedOnceConfig` refuses production, a missing runtime database URL, unknown, duplicated or valueless arguments and an out-of-range `PHARMACART_FEED_LOCK_TIMEOUT_MS`. `loadFeedManifestFile` reads at most 64 KiB and applies `readFeedManifest`, including its synthetic-subject rule. All of that happens before a pool is created. The exit code is 0 when every file was accepted or a duplicate, 1 when the pass or a file was refused, and 2 for invalid configuration. There is no npm script, because the root manifest belongs to the coordinator.

## 7. Boundary

This moves AC-003 evidence to the feed edge without completing it: replay through a real inbox is exercised, but AC-003 also requires no duplicate need or alert, and this sink produces neither needs nor alerts at all. AC-013 and AC-016 likewise gain feed-path evidence only. All three stay NOT RUN.

The installation subject is trusted service configuration. SQL context is not authentication, and this local worker authenticates nothing. A deployed connector would need the same authenticated subject binding the API path has.

One-second sequence resolution still applies. Two genuinely different exports in one second are now refused by name instead of being silently mis-handled, but the second one is still not accepted. Re-dropping an export older than the watermark is refused as `stale_export`, not reported as a duplicate, which is the documented behaviour of `deriveSnapshotEnvelope`.
