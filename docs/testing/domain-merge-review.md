# Domain package merge review

Claude branch: claude/domain-packages at bcf0f4f, based on ad17630. B3 was preserved and committed separately as c6f8a80 before merging. Only package.json conflicted; both unit test glob sets and B3 database coverage/dev commands are retained.

Astra read package boundary documentation and reviewed the domain/adapter interfaces. The packages are being integrated as unconnected building blocks. No acceptance criterion moves from this merge. In particular, path-boundary includes an asynchronous filesystem helper; the broad handoff description of every package as pure should not be treated as a verified property.

## Follow-ups before runtime wiring

- Supplier ranking must receive validated non-negative price/quantity and bounded performance values. The current public function does not enforce every commercial range. Insufficient performance samples must remain unrated, with a deliberate exploration policy.
- Need derivation must reject or explicitly aggregate duplicate positions instead of relying on last-entry Map behavior; validate non-negative quantities before using its result.
- Coverage derivation skips receipts with invalid timestamps. Runtime ingestion must reject malformed history before forecasts can influence purchasing.
- A contained resolved path is not an atomic open. The drop-directory adapter needs bounded reads and a documented policy for links and concurrent file replacement.
- Preserve the documented second-resolution feed identity limitation. The accepted watermark must be read and checked inside the transaction that accepts the event.
- Unknown-outcome orders require a reconciliation hold before creating replacement purchases; treating unknown as simply zero or fully delivered is insufficient. No new commitment computation is wired by this merge.

These are integration prerequisites, not acceptance evidence. Existing documentation records forecasting assumptions and ranking feedback limitations; they remain applicable.

## Independent Sol review and corrections

Fresh Sol capacity was available. The reviewer found a symlink-blind reader and missing pre-read byte bounds, plus identity, superseded-quote and XML refusal defects. A separate Sol implementer owned only text-identity, offline-draft and XML source/tests. Astra reviewed the six-file correction: Unicode decimal digits outside ASCII, whitespace-only identifiers and C1 controls are refused; superseded quotes cannot be reapproved; XML closing names must match the stack.

The targeted 52-test suite recorded five intended assertion failures before implementation, then 52 passing tests. Retained evidence: domain-refusal-red.txt and domain-refusal-green.txt. These are regression evidence for policy behavior, not an AC PASS.

The feed reviewer then implemented a concrete contained filesystem reader and an explicit bounded-reader contract, with exclusive ownership of feed-ingestion and path-boundary. Astra reviewed the implementation and requested preservation of named reader-error refusals and rejection of non-regular handles. The final targeted suite passed 25 tests, including a synthetic escaping link, oversized file and thrown reader.

Initial feed RED includes API-shape failures (missing new export/signature); it is not represented as a clean assertion-only reproduction of the old symlink defect. A separate retained reader-error RED records 24 passes and one intended thrown-reader failure before its correction. Evidence: feed-review-red.txt, feed-review-red-reader-errors.txt and feed-review-green.txt.

The reader bounds chunk allocations and stops at the configured byte ceiling plus a one-byte probe. The byte ceiling is trusted service configuration. Canonical-path checks do not provide atomic Windows protection against an adversary renaming directories during opening; service-owned directories remain a deployment prerequisite. No drop-directory worker or durable feed wiring was introduced.

## Final verification

The corrected combined tree passed 343 tests: 324 unit/contract and 19 PostgreSQL integration. Coverage: 96.27% lines, 88.88% branches, 94.95% functions. Full output: domain-merge-coverage.txt. Clean install, typecheck, lint, generated-contract verification and build passed. The separate integration command passed 19 tests before the final pure-package fixes; the final coverage command reran those same database tests. Dependency audit reported zero vulnerabilities. Compiled API health and OpenAPI endpoints returned HTTP 200.
