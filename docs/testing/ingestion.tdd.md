# Ingestion domain evidence

Sol implemented the initial pure mapping/snapshot modules and 14 unit tests. Astra reviewed them after the agent hit its usage limit.

Observed RED: five added regression tests failed on older in-progress snapshot overwrite, globally scoped event identity, repeated completion publishing twice, object-key-order-sensitive fingerprints and prototype-name identifiers.

Fixes: monotonic sequence checks apply even to known in-progress snapshots; event keys include installation; canonical field-order fingerprints ignore input object key ordering; already completed snapshots do not increment projection revisions again; record lookup uses own properties and safe property definitions. Identifiers are bounded and reject embedded delimiter characters.

Observed GREEN: `node --test packages/domain/test/*.test.ts` passed all 19 tests, zero skipped. The root test command includes these tests. Incomplete snapshots keep previous observations as stale until all declared partitions arrive; conflicting inputs are rejected without mutating prior state.

These are pure, in-memory domain rules. They do not establish durable inbox identity, database projection atomicity, authenticated installations, restart safety or full AC-002/AC-003/AC-004 acceptance.
