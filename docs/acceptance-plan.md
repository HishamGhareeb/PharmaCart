# PharmaCart acceptance plan

## Purpose and status rules

This plan traces the required acceptance criteria in the PharmaCart Builder Master Plan to delivery stages and planned evidence. It is a B0 acceptance planning artifact. Separate foundation validators, fixtures and unit tests now exist; their evidence is in docs/testing/b0-progress.md and does not satisfy the acceptance criteria below.

All criteria currently have status **NOT RUN**. A criterion may move to PASS only when its named test runs against local or isolated staging fixtures and the release evidence retains the command output, environment versions, relevant migration results, and supporting logs or screenshots. Skipped, blocked, or partially exercised criteria remain NOT RUN or become FAIL; they are never counted as PASS.

No acceptance test may contact a real supplier or modify a pharmacy system. Critical failures in authorisation, product-pack matching, or duplicate-order prevention block release.

## Stage traceability

| Stage | Acceptance exit gate | B0 dependency |
| --- | --- | --- |
| B1 - identity, tenancy, mappings, ingestion | AC-001 through AC-004 | Local identity boundary, PostgreSQL/RLS, canonical contracts, synthetic organisations/products/feed envelopes |
| B2 - offers, quotes, budgets, approval | AC-005, AC-007, AC-008 | Exact-decimal fixtures, versioned offers/quotes, budget and idempotency scenarios |
| B3 - fake-supplier submission and reconciliation | AC-006, AC-009, AC-010, AC-014 | Deterministic fake supplier, fault scripts, receipt and recovery fixtures |
| B4 - generic transports and service pairing | AC-011, AC-013, AC-015, AC-016 | Equivalent transport inputs, malicious-input corpus, revocable installations, durable queue scenarios |
| B5 - clients and notifications | AC-012, AC-017, AC-018 | Offline/terms-change scenario, quiet-hours clock, English/Arabic product and UI data |

## Required criteria

| ID | Source trace | Stage | Required assertion | Planned test approach and evidence | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | Sections 11 and 34; tenant RLS and private-resource isolation | B1 | Organisation A requesting B's private resource receives 404 with no private fields and no cross-tenant disclosure. | API/RLS integration test against real local PostgreSQL; exercise application authorisation and RLS under pooled connections, retain request/response and database assertion output. | NOT RUN |
| AC-002 | Sections 15 and 34; commercial pack identity | B1 | Ambiguous text for the same brand with two strengths is held for review; no wrong pack is automatically approved. | Mapping unit test plus quote integration test using two otherwise similar packs; retain mapping decision and blocked-quote assertions. | NOT RUN |
| AC-003 | Sections 16, 21 and 34; durable inbox and replay | B1 | Replaying one inventory event produces one inbox identity and one projection update, with no duplicate need or alert. | Transport contract test sends an identical event twice and queries inbox, projection, need, and alert identities; retain adapter/test output. | NOT RUN |
| AC-004 | Sections 16 and 34; multipart snapshot completion | B1 | If only one of two snapshot parts arrives, prior missing rows remain available as stale observations and are not treated as zero stock. | Snapshot integration test stages a prior completed snapshot, ingests one partition without completion, and asserts projection quantity/freshness. | NOT RUN |
| AC-005 | Sections 20 and 34; atomic approval and uniqueness | B2 | Simultaneous approval by two clients creates one intent per supplier and one budget reservation, with no duplicate purchase. | Concurrent PostgreSQL integration test with a barrier around two approval requests; retain both responses and row-count/constraint assertions. | NOT RUN |
| AC-006 | Sections 20 and 34; unknown external outcome | B3 | When the fake supplier accepts and the connection times out, the intent becomes unknown and lookup finds the original order; no blind resubmission occurs. | Scripted fake-supplier fault test records one submit call, injects post-accept timeout, runs reconciliation lookup, and retains call ledger/state-transition evidence. | NOT RUN |
| AC-007 | Sections 23 and 34; command idempotency | B2 | Reusing an idempotency key with a changed request body returns 409 and performs no mutation. | API integration test compares database state before and after the conflicting request and retains response/error-code output. | NOT RUN |
| AC-008 | Sections 19 and 34; quote freshness/version | B2 | A price change after quote creation forces requoting; the old total cannot be approved silently. | Quote integration test updates the versioned offer, submits approval for the old quote version, and asserts rejection plus a new quote requirement. | NOT RUN |
| AC-009 | Sections 20 and 34; line-level partial acceptance | B3 | Supplier acceptance of fewer units remains visible as accepted and rejected quantities per line; full acceptance is not inferred. | Adapter contract test plus UI state test using a mixed partial response; retain canonical order JSON and rendered/state assertions. | NOT RUN |
| AC-010 | Sections 14, 26 and 34; receipt/writeback idempotency | B3 | Confirming the same partial receipt twice retains one receipt identity and permits one writeback, with no duplicate stock receipt. | Receipt fault test repeats a stable receipt reference around a simulated lost response and asserts receipt/writeback uniqueness. | NOT RUN |
| AC-011 | Sections 18 and 34; Windows durable queue | B4 | Closing the UI during queued sync and restarting the service resumes the same durable events; no events are lost or assigned new identities. | Windows lifecycle test uses a temporary service data directory and SQLite queue, terminates/restarts at a controlled point, and compares event IDs and acknowledgements. | NOT RUN |
| AC-012 | Sections 25 and 34; offline approval guard | B5 | An offline draft reconnecting after terms change refreshes and requires manual approval; it never submits automatically. | Client end-to-end test controls connectivity and server terms version, then asserts refreshed terms, approval prompt, and zero submit calls before user action. | NOT RUN |
| AC-013 | Sections 18 and 34; parser and path boundaries | B4 | Malicious XML, file, or path input is rejected with bounded resource use and cannot read local secrets or execute content. | Parser security tests cover traversal, external links/entities, macros/formulas, oversized/decompression inputs, and allowlisted roots; retain rejection and resource-limit evidence. | NOT RUN |
| AC-014 | Sections 20, 21 and 34; restore/replay safety | B3 | After restoring a database whose external order was already accepted, dispatch remains paused until reconciliation; the accepted order is not replayed. | Recovery drill restores a prepared backup, inspects the fake supplier ledger, runs recovery, and proves lookup/reconciliation precedes any permitted dispatch. | NOT RUN |
| AC-015 | Sections 16-18 and 34; transport equivalence | B4 | Equivalent stock expressed through every supported transport yields the same canonical projection and purchase meaning. | Cross-transport contract suite runs JSON/API, database-view, and file fixtures where supported, then deep-compares canonical projections including units, versions, and freshness. | NOT RUN |
| AC-016 | Sections 11, 12, 18 and 34; revocation | B4 | Revoked membership or installation is denied on its next request and sync pauses; authorised writes do not continue. | Revocation integration test uses an established session/paired service, revokes it, then asserts immediate API denial, connector health, queue state, and no new writes. | NOT RUN |
| AC-017 | Sections 22 and 34; alert episode privacy/deduplication | B5 | A repeated alert during quiet hours yields one episode and policy-respecting delivery, with no duplicate push or sensitive lock-screen data. | Notification test uses a controllable clock/time zone and fake delivery sink; retain episode count, scheduled delivery, and redacted payload assertions. | NOT RUN |
| AC-018 | Sections 16, 24 and 34; Arabic, RTL, accessibility | B5 | An Arabic, keyboard-only user can complete a purchase through reachable controls and readable codes with the same approved result; RTL must not alter product identity. | Manual device/accessibility review, supplemented by automated keyboard-path and locale assertions; retain checklist, screenshots/device logs, identifiers, and resulting order comparison. | NOT RUN |

## Planned execution record

For each run, record the criterion ID, timestamp, commit, stage, environment and dependency versions, fixture-set version/hash, exact command, result, evidence paths, defects, and reviewer. Test commands will be documented when their runners exist. At B0 there are no implemented test commands to list.

The proposed load fixture and performance targets (100 organisations, 50,000 canonical packs, 500,000 offers, 20 interactive sessions, five feed workers; p95 reads under 800 ms and quotes under two seconds) are engineering targets only. They are outside AC-001 through AC-018 and must not be reported as demonstrated performance until measured on recorded hardware.

