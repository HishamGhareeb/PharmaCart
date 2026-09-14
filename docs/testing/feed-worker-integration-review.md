# Feed worker integration review

Integrated from `tmp/claude-feed`:

- `apps/worker/src/feed-worker.ts` (generic bounded pass with injected reader and sink)
- `apps/worker/test/feed-worker.test.ts`
- `packages/feed-ingestion/src/ingest-delimited-feed.ts`
- `packages/feed-ingestion/src/snapshot-completion.ts`
- `packages/feed-ingestion/test/read-feed-rows.test.ts`
- `packages/feed-ingestion/test/snapshot-completion.test.ts`

The worker now enumerates with `opendir`, stops after `maxFiles + 1`, and refuses
the pass when the bound is exceeded. `runFeedPass` also rechecks that its typed
manifest is finite, within the configured ceiling, and single-file before it
opens the directory. The persistence sink and one-shot CLI remain pending until
the database feed module is integrated; no database imports are introduced here.

Validation is limited to the focused feed tests, typecheck, and lint. The
original RED evidence from the source review is retained in
`tmp/claude-feed/docs/testing/guarded-feed-worker.md`; no new RED checkpoint was
claimed for this integration pass.
