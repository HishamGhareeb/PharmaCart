# Fixture contract regression evidence

The coordinator integrated the previously separate fixture and contract modules. The old fixture tests accepted padded decimals and did not validate UUID shape.

RED: `node --test packages/test-fixtures/test/*.test.ts` executed eight tests, with two failures. Generated IDs contained a five-character UUID segment (`81100`); prices such as `100.50` and quantities such as `20.0` failed canonical decimal validation.

GREEN: after correcting the UUID group and emitting canonical decimals, the same command passed eight tests, with zero failures/skips. Snapshot quantities now also use canonical strings.

The tests use contract validators for fixture offers and a UUID pattern for entity IDs. They prove fixture compatibility, not application procurement behavior. Historical B0 coverage evidence predates these regressions and should not be treated as proving all cross-module invariants.

Checkpoint commits were not created during concurrent agent edits. Runtime RED/GREEN evidence is preserved here; no claim of complete commit-based TDD evidence is made.
