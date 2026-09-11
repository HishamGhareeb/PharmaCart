# PharmaCart synthetic test fixtures

## Scope

This package contains an invented, deterministic B0 fixture graph for local and isolated staging tests. No customer catalogue, supplier payload, pharmacy export, patient data, credentials, or production endpoint may be included. Fixture names and identifiers make their synthetic origin obvious.

Generate a fresh fixture graph with `createSyntheticFixtureSet()` from `src/index.ts`. Each call returns a deep clone, so a test can safely mutate its copy. The clock, UUIDs, source codes, prices, quantities, and scenario inputs are fixed.

Run the repository's dependency-free Node.js 24 test suite:

```powershell
npm test
```

Run native coverage with:

```powershell
npm run test:coverage
```

## Baseline fixture set

The implemented B0 seed set provides:

- two synthetic pharmacy organisations and two synthetic supplier organisations;
- two branches per pharmacy, each with an explicit IANA time zone;
- at least three member roles, including purchaser, receiver, and an owner or administrator, with branch-scoped and revoked memberships;
- account relationships that differ by pharmacy, branch, price, terms, and status;
- 30 invented commercial product packs covering changed source identifiers, leading-zero codes, same-brand/different-strength ambiguity, dosage-form differences, and mixed box/strip/base-unit mappings;
- a review-required ambiguous product pair;
- active account-specific offers, one expired offer, and exact decimal/currency strings;
- an incomplete multipart snapshot scenario whose expected projection retains prior stock as stale;
- stable clocks, UUIDs, external references, source versions, event IDs, payload hashes, snapshot IDs, correlation IDs, and idempotency keys so repeated runs compare exactly.

All timestamps use UTC instants; schedules and quiet hours additionally identify an IANA time zone. Source identifiers remain strings. Money and quantities use decimal strings at contract boundaries. Product descriptions include English, Arabic, mixed-direction codes, and Arabic search variants while preserving original identifiers.

## Scenario catalogue

The current generator directly supplies the following acceptance foundations:

| Scenario | Minimum fixture behavior |
| --- | --- |
| AC-002 | Same brand, two strengths, deliberately ambiguous source text |
| AC-004 | Prior complete snapshot plus one of two new partitions and no completion marker |

## Planned fixture extensions

The remaining acceptance scenarios, fake supplier, transport representations, invalid-input corpus, order lifecycle, notifications, and Arabic client fixtures remain specifications for later stages. The fake supplier must eventually be deterministic and local, record requests without secrets, and support scripted accepted, rejected, partial, timeout, and lookup outcomes. It must remain impossible to configure with a real supplier URL.

## Transport fixture rules

Each transport representation must map to one canonical expected document. Equivalent fixtures preserve product, unit conversion, quantity meaning, source ordering, observation time, snapshot identity, and account scope. Invalid fixtures declare the expected machine-readable error. Full snapshots declare expected partitions and completion; incomplete snapshots never imply deletion or zero stock.

The current graph carries fixture version `1.0.0`. A content hash, external manifest, schema version negotiation, and generator seed are not implemented yet. Future manifests should include those fields, intended AC IDs, and licence marker `synthetic/invented`.

## Scale profiles

Keep the 30-pack baseline small enough for routine tests. Generate volume data from deterministic rules rather than copying real catalogues. The proposed pilot profile is 100 organisations, 50,000 canonical packs, 500,000 offers, 20 concurrent interactive sessions, and five feed workers. Results from this generated profile are valid only when the seed, generator version, hardware, and environment are recorded; the profile and its p95 targets are not demonstrated performance.

## Safety and maintenance

Fixtures must use reserved example domains, non-routable/local endpoints, obviously fake people and organisations, and unusable credential placeholders. Tests that simulate writes target only disposable local databases, temporary directories, fake delivery sinks, and the fake supplier ledger. Network access is disabled for the acceptance suite unless an isolated local service is explicitly part of the test.

When a fixture changes, preserve older fixture versions needed for replay/compatibility checks or document the intentional break. Mapping changes must not rewrite historical order expectations. Never label a fake adapter or a single installation fixture as vendor-certified.

## Current limitations

This B0 package is an in-memory TypeScript generator only. It has no database seed loader, JSON files, contract schema, fake supplier, network transport, volume generator, Arabic UI copy, patient data, or live-system integration. Its tests validate determinism, isolation, counts, references, and the implemented scenario invariants; they do not mark any AC-001 through AC-018 acceptance test as run or passed.
