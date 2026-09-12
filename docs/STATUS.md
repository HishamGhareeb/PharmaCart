# PharmaCart current build status

Date: 2026-09-12. Current implementation status; historical evidence is under docs/testing.

Latest combined verification: 343 tests pass (324 unit/contract and 19 PostgreSQL integration). Coverage: 96.27% lines, 88.88% branches, 94.95% functions. Type checking, lint, generated contracts and build passed during this slice. Ten migrations are applied locally. See testing/b3-progress.md.

## Delivered implementation

- B0: Fastify API, generated OpenAPI, local OIDC authorization-code/PKCE provider, JWT verification, setup/dev/build/start commands and restricted database runtime credentials.
- B1: authenticated organisation/branch membership checked per transaction; tenant API isolation; durable inbox, multipart inventory checkpoints and projections, replay handling and shortage needs/alerts.
- B2: transactional quotes and approvals, exact PostgreSQL numeric pricing, version checks, budget reservations, concurrent approval idempotency, supplier intents and transactional outbox.
- B3: file-backed fake supplier, paused startup and lookup before dispatch, uncertain-outcome reconciliation, stable restored order identities, quantity-bounded idempotent receipts and budget settlement. A real disposable database dump/restore test keeps the independent supplier ledger intact.

## Acceptance and boundaries

AC-001 through AC-018 remain NOT RUN as complete acceptance gates. The integration tests are partial evidence, not completion of the acceptance plan. No client application or real supplier integration exists. The worker is a synthetic one-shot runner, not the planned durable scheduler. Receipt writeback is queued, not delivered externally.

Commercial fixtures currently use EGP cash, a named tax-exempt pricing rule and a five-minute quote lifetime. Mapping administration and supplier selection policies are not integrated. Partial-need fulfilment and cross-branch idempotency key collision handling require further review before claiming B2 complete. Open commitments and unknown-outcome replenishment policy remain to be enforced. Local OIDC uses development interactions and ephemeral keys.

Claude's 13 domain packages are merged with reviewed feed read-boundary and refusal corrections. The final combined tree passes 343 tests. The packages remain unconnected to runtime request/worker paths; their pure tests alone do not advance acceptance status. Review and retained RED/GREEN evidence: testing/domain-merge-review.md.

## Team and next work

GPT-6 Astra coordinates and reviews. Three earlier GPT-5.6 Sol workstreams exhausted capacity; Astra completed interrupted integration locally. Fresh Sol capacity is now available: two bounded agents are reviewing and fixing the domain merge with exclusive ownership. No reset credits or paid services were used.

Next: enforce installation lifecycle at the request boundary and connect guarded feed ingestion to a real worker. Commercial policy hardening is assigned to Claude on a separate worktree/branch; do not overlap those four packages. Preserve the transactional feed watermark and treat insufficient supplier samples as unrated.
