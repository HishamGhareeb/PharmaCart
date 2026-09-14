# Feed persistence sink test evidence

Lane: `claude/feed-persistence-sink`, based on cd4bb7e. Design: ../feed-sink.md.

This file separates evidence the builder observed from evidence only the coordinator can produce. No PostgreSQL test has been run by the builder. Nothing below claims one passed.

## Tests written

| File | Touches PostgreSQL | Run by builder |
| --- | --- | --- |
| `packages/db/test/feed-sink.test.ts` | yes | no |
| `packages/db/test/feed-sink-policy.test.ts` | no (recording client) | no, because it sits under packages/db/test |
| `apps/worker/test/feed-once-config.test.ts` | no | yes |

### packages/db/test/feed-sink.test.ts

1. A single-file export persists once, with its identity row, inbox rows, exact-decimal projection and no need or alert; a re-read with rows in a different order is a duplicate; a later export advances the projection once; the first export re-dropped is `stale_export`.
2. Anything other than a replay at a claimed second is refused as `changed_content_same_sequence`, `changed_batch_same_sequence` or `changed_partition_same_sequence`, and nothing moves. Another installation can use the same batch key in the same second.
3. Pending, suspended, revoked and unknown installations are refused by name, and nothing is persisted, not even the empty inventory checkpoint.
4. Two passes submitting the same export while the inventory lock is held produce one identity, one projection update, and one duplicate.
5. Racing exports under another batch key, then with changed content, produce one accepted identity and one named refusal each.
6. With a newer pass queued ahead of an older one, the older pass is refused as `stale_export` at the sink, which shows the watermark is read inside the transaction.
7. A held lock with a 250 ms bound is refused as `lock_timeout` well inside 2.5 s, and the connection is reusable afterwards.
8. The projection-advanced seam sees the new projection inside the transaction, is skipped for a duplicate, and its failure rolls the snapshot back.
9. `runFeedPass` with in-memory directory and reader plus the real sink: accepted, then duplicate, then `persistence:installation_suspended`.
10. `feed_sequence_identity` stays SELECT and INSERT only for the runtime role, with forced row-level security.

Concurrency tests hold the `inventory_state` row lock from a separate psql session and wait until `pg_stat_activity` shows the passes queued, so the overlap is guaranteed rather than left to timing.

## Commands for the coordinator

Run these serially against the shared test database:

```
node --experimental-strip-types --test --test-concurrency=1 packages/db/test/feed-sink.test.ts
node --experimental-strip-types --test packages/db/test/feed-sink-policy.test.ts
```

Both are also picked up by `npm run test:integration` and `npm run test:coverage` through the existing `packages/db/test/*.test.ts` glob. The worker test is covered by `npm test` through `apps/worker/test/*.test.ts`.

## Builder-observed evidence

- RED: `node --experimental-strip-types --test apps/worker/test/feed-once-config.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `apps/worker/src/feed-once-config.ts` before the module existed. That is a missing-module RED, not a behavioural one.
- GREEN: the same command passed 8 of 8 after implementation. `apps/worker/test/*.test.ts` passed 28 of 28.
- `npm run typecheck` and `npm run lint` exited cleanly with no output beyond the script banner.
- The one-shot entry point exited 2 with `missing_database_url`, `manifest_unreadable` and `missing_argument` for invalid configuration, before creating a pool.
- The policy test's assertions were checked with a scratchpad copy whose import paths were rewritten, since the file itself may not be run by a builder. The first run failed several tests (the visible output showed at least four) because the fixtures used non-canonical `8.250`, which the reducer rightly rejects as `invalid_event`. After switching the fixtures to canonical `8.25`, the copy passed 14 of 14. The coordinator should still run the real file.

No RED was captured for the sink tests against an absent `feed-sink.ts`; the implementation was written before a missing-module run was taken.

## Coordinator verification

Run by the coordinator, the single database test runner, on this worktree at base `cd4bb7e`. The builder wrote the tests but was barred from running any database test.

RED, with `packages/db/src/feed-sink.ts` moved aside and then restored:

```
$ node --experimental-strip-types --test --test-concurrency=1 packages/db/test/feed-sink.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/db/src/feed-sink.ts'
tests 1, pass 0, fail 1
```

GREEN:

| Command | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 packages/db/test/feed-sink.test.ts` | 10 | 10 | 0 |
| `node --experimental-strip-types --test packages/db/test/feed-sink-policy.test.ts` | 14 | 14 | 0 |
| `node --experimental-strip-types --test apps/worker/test/feed-once-config.test.ts` | 8 | 8 | 0 |
| `npm run typecheck`, `npm run lint` | | pass | |

The two race tests hold the `inventory_state` lock from a separate session so the overlap is forced rather than timing-dependent. Both passed on the first run.

## Coordinator review notes

Reviewed before integration as `docs/RELEASE-GATE.md` requires. No finding blocks the merge. Four notes are carried forward.

**A. The sink is a server-side component and must not run inside the on-premise agent.** It trusts its configured installation subject and authenticates nothing, because it holds a database pool. That is correct for a worker processing a drop directory the server controls. It would be wrong on a pharmacy's machine: anyone holding that connection could submit inventory as any installation. The planned Windows service must reach the server through the authenticated API instead.

**B. Every accepted snapshot deletes and reinserts the installation's whole projection.** That is correct and matches the existing inventory path, but the cost grows with catalogue size per submission. It needs measuring before any capacity claim.

**C. Refusal names are finer than migration 0013's comment.** The table comment files every non-replay under `changed_content_same_sequence`; the sink distinguishes `changed_content_same_sequence`, `changed_batch_same_sequence` and `changed_partition_same_sequence`, which names the real problem as 0013 itself argues for. Migration 0013 cannot be edited to match, because the migration ledger records its source hash, so the finer names are documented here and in `docs/feed-sink.md`.

**D. About ten lines of inbox, checkpoint and projection SQL repeat `ingestInventory`.** `ingestInventory` opens a transaction per event and always derives needs, so it could not be called unchanged. Extracting a shared function in `packages/db/src/inventory.ts` is a follow-up, deferred so as not to touch that file while other lanes are open.
