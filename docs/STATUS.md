# PharmaCart current build status

Date: 2026-09-14. Current implementation status; historical evidence is under docs/testing.

Latest verification on the merged tree: 545 unit/contract/policy tests and 149 PostgreSQL integration tests pass. Coverage measured 96.95% lines, 87.76% branches and 95.79% functions; the initial combined run completed 693 of 694 tests and exposed a Windows Docker restore timeout, then both affected restore cases passed individually and the complete 149-test integration gate passed after their finite bounds were corrected. The nested local web app passes 136 tests, type checking, lint and a production Next.js build. Root type checking, lint, generated-contract verification and build also pass. The disposable test database applies all seventeen migration files through 0019 on reset; sequence numbers 0016 and 0017 are intentionally unused.

## Delivered implementation

- B0: Fastify API, generated OpenAPI, local OIDC authorization-code/PKCE provider, JWT verification, setup/dev/build/start commands and restricted database runtime credentials.
- B1: authenticated organisation/branch membership checked per transaction; tenant API isolation; durable inbox, multipart inventory checkpoints and projections, replay handling and shortage needs/alerts.
- B2: transactional quotes and approvals, exact PostgreSQL numeric pricing, version checks, budget reservations, concurrent approval idempotency, supplier intents and transactional outbox.
- B3: file-backed fake supplier, paused startup and lookup before dispatch, uncertain-outcome reconciliation, stable restored order identities, quantity-bounded idempotent receipts and budget settlement. A real disposable database dump/restore test keeps the independent supplier ledger intact.

## Acceptance and boundaries

AC-001 through AC-018 remain NOT RUN as complete acceptance gates. The integration tests are partial evidence, not completion of the acceptance plan. A local-only Next.js purchase-loop client now exists with server-held OIDC tokens, PKCE, CSRF protection and bounded sessions; it has not passed a live authenticated browser gate. No real supplier integration exists. The worker is a synthetic one-shot runner, not the planned durable scheduler. Synthetic receipt writeback and notification delivery are durable and bounded; no external production adapter is configured.

Commercial fixtures currently use EGP cash, a named tax-exempt pricing rule and a five-minute quote lifetime. Explicit human mapping and tenant-list routes are now registered by buildTenantApi and described in the generated OpenAPI document; their live contract test awaits the coordinator's database run, and the list role policy (currently pharmacy_owner or purchaser) awaits final human review (testing/api-registration-openapi.md). Neutral supplier ranking, filters and multi-supplier allocation are hardened pure policy and are not yet called by procurement. Partial approvals preserve an open remainder; cross-branch idempotency key conflicts return 409 with rollback. Open commitments and unknown-outcome replenishment policy remain to be enforced. Local OIDC uses development interactions and ephemeral keys.

Claude's 13 domain packages are merged with reviewed feed read-boundary and refusal corrections. The domain merge passed 343 tests; the latest builder integration passes 384. Installation lifecycle is now connected to inventory authorization; other new policies still require their own runtime integration. Pure tests alone do not advance acceptance status. Review and retained RED/GREEN evidence: testing/domain-merge-review.md.

## Team and next work

GPT-6 Astra coordinates and reviews. The latest five Claude Opus 5 lanes are complete. Their web, tenant-list and commercial-policy changes were independently reviewed and verified in the shared tree; the feed worker boundary was integrated from the completed Codex lane. Delivery/alert and commitment-aware feed persistence remain isolated because review found correctness and concurrency blockers. No reset credits or paid services were used.

Installation lifecycle is enforced in the inventory and feed persistence paths, including terminal revocation and locking. The worker now persists bounded, guarded single-file passes with a transactional watermark. Commitment-aware reconciliation, canonical UUID guards, registered mapping/list OpenAPI contracts, synthetic receipt writeback and redacted alert delivery have PostgreSQL coverage. Remaining integration work is to invoke reconciliation from the accepted feed transaction, build the positive receipt-inclusion writer, wire neutral supplier selection into quote creation, and run the local web purchase loop end to end. Preserve the transactional feed watermark and treat insufficient supplier samples as unrated.
