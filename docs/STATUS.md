# PharmaCart current build status

Date: 2026-09-13. Current implementation status; historical evidence is under docs/testing.

Latest combined verification: 365 tests pass (335 unit/contract/policy and 30 PostgreSQL integration). Coverage: 96.46% lines, 89.41% branches, 96.10% functions. Type checking, lint, generated contracts and build passed during this slice. Twelve migrations are verified on the isolated test database. See testing/b3-progress.md.

## Delivered implementation

- B0: Fastify API, generated OpenAPI, local OIDC authorization-code/PKCE provider, JWT verification, setup/dev/build/start commands and restricted database runtime credentials.
- B1: authenticated organisation/branch membership checked per transaction; tenant API isolation; durable inbox, multipart inventory checkpoints and projections, replay handling and shortage needs/alerts.
- B2: transactional quotes and approvals, exact PostgreSQL numeric pricing, version checks, budget reservations, concurrent approval idempotency, supplier intents and transactional outbox.
- B3: file-backed fake supplier, paused startup and lookup before dispatch, uncertain-outcome reconciliation, stable restored order identities, quantity-bounded idempotent receipts and budget settlement. A real disposable database dump/restore test keeps the independent supplier ledger intact.

## Acceptance and boundaries

AC-001 through AC-018 remain NOT RUN as complete acceptance gates. The integration tests are partial evidence, not completion of the acceptance plan. No client application or real supplier integration exists. The worker is a synthetic one-shot runner, not the planned durable scheduler. Receipt writeback is queued, not delivered externally.

Commercial fixtures currently use EGP cash, a named tax-exempt pricing rule and a five-minute quote lifetime. Mapping administration and supplier selection policies are not integrated. Partial approvals now preserve an open remainder; cross-branch idempotency key conflicts return 409 with rollback. Open commitments and unknown-outcome replenishment policy remain to be enforced. Local OIDC uses development interactions and ephemeral keys.

Claude's 13 domain packages are merged with reviewed feed read-boundary and refusal corrections. The domain merge passed 343 tests; the latest builder integration passes 365. The packages remain unconnected to runtime request/worker paths; their pure tests alone do not advance acceptance status. Review and retained RED/GREEN evidence: testing/domain-merge-review.md.

## Team and next work

GPT-6 Astra coordinates and reviews. Three earlier GPT-5.6 Sol workstreams exhausted capacity; Astra completed interrupted integration locally. Fresh Sol capacity is now available: two bounded agents are reviewing and fixing the domain merge with exclusive ownership. No reset credits or paid services were used.

Installation lifecycle is now enforced in the inventory request path, including terminal revocation and locking. Concurrent synthetic supplier access, stale reconciliation and receipt rollback are covered. Next: connect guarded feed ingestion to a real worker with transactional identity and commitment-aware need updates. Commercial policy hardening is assigned to Claude on a separate worktree/branch; do not overlap those four packages. Preserve the transactional feed watermark and treat insufficient supplier samples as unrated.
