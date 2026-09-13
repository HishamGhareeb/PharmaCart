# Feed manifest boundary review

The coordinator reviewed the completed feed and need builder sources locally while Claude usage was paused. The database modules and migrations 0013/0014 remain unintegrated and unapplied.

Two concrete feed issues blocked wiring the worker:

- Date.parse accepted timezone-free timestamps and normalized invalid calendar dates. A timezone-free timestamp changes its instant across host timezones, undermining replay identity.
- The manifest accepted multiple files sharing a batch and timestamp, while the worker completes each file independently. Later partitions can be refused after an earlier file commits. This is not an atomic multipart batch.

The manifest parser is now integrated as a preparatory module. It requires the existing strict UTC instant contract, including calendar validity, and refuses multiple files with multipart_batch_unsupported after validating their individual identities. A multi-file transport requires a shared transactional completion boundary before this refusal can be removed. Directory enumeration limits remain independently configurable.

RED checkpoint 09ec38b: 12 tests, 10 passed and two failed against the builder implementation. GREEN: all 23 feed-ingestion tests pass. Typecheck, lint and generated-contract verification pass. Raw evidence remains in ignored tmp/feed-manifest-review-red.txt and tmp/feed-manifest-review-green.txt.

The first focused coverage command included imported dependency modules without their own suites, and failed its aggregate 80% thresholds (77.92% lines, 70.03% branches, 74.68% functions). This is retained in tmp/feed-boundary-coverage.txt. Measuring the owned feed-ingestion source scope with --test-coverage-include='**/feed-ingestion/src/*.ts' passes: 98.85% lines, 88.62% branches, 100% functions. The manifest itself has 99.12% line and 88% branch coverage. The full repository's last verified checkpoint remains the 384-test OpenAPI integration; this scoped check does not replace that gate.

No worker command is exposed by this change, and no acceptance criterion moves. Next integration must enforce the same instant boundary at ingestFeedSnapshot, not only in the CLI parser, and test feed/need transactions against PostgreSQL before applying migrations to the development database.
