# Resumed builder and verification checkpoint

2026-09-13, coordinator checkout based on 3c5157d; uncommitted changes are not a release candidate.

The ten existing Claude Opus 5 sessions resumed after a direct capacity probe returned CAPACITY_OK. Their original isolated worktrees and exclusive ownership remain in force. All ten showed tool activity. No builder is authorised to run shared database resets, apply migrations, commit, push or change another worktree. Current slices remain unintegrated.

The earlier clean install, typecheck, lint and generated-contract verification completed successfully. The resumed coverage run completed with 365 tests: 364 passed and one failed. Coverage was 96.46% lines, 89.43% branches and 96.10% functions. Raw output: ignored tmp/resume-coverage.txt.

The failed supplier restore drill reported `Called end on pool more than once` from its finally block. The test closes its first pool before restoring, so a restore or reconnect failure can be masked by closing that pool again. Cleanup now checks pool.ending before closing. The original underlying failure is unknown; no root cause is claimed.

An isolated rerun passed one test in approximately 30 seconds (tmp/restore-diagnostic.txt). That rerun started before the cleanup edit and is evidence of intermittent behaviour, not a regression test proving the cleanup fix. Typecheck passed after the edit. A new sequential integration run is pending; the failed coverage run is not reclassified as green.

The need builder was explicitly instructed that applied writeback does not prove receipt inclusion in a later inventory snapshot. The verifier builder must bound logs and refuse evidence-directory reuse. The OpenAPI builder is writing real authenticated PostgreSQL response-conformance tests; execution remains the coordinator responsibility.

AC-001 through AC-018 remain NOT RUN as full acceptance gates. No deployment-readiness claim follows from this checkpoint.

Follow-up: the sequential integration run passed all 34 tests (30 database and four database-free). The subsequent OpenAPI integrated coverage run passed 384 tests, including 31 database tests, with exit 0. The failed earlier coverage run remains retained. Later Claude reviews and commercial-fix work were interrupted by the shared limit; no independent-review completion is claimed. Further Claude launches are paused by user instruction.
