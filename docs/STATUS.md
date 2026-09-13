# PharmaCart current build status

Date: 2026-09-13. Current implementation status; historical evidence is under docs/testing.

Latest combined verification: 384 tests pass (353 unit/contract/policy and 31 PostgreSQL integration). Coverage: 96.56% lines, 89.56% branches, 96.45% functions. Type checking, lint, generated contracts and build passed during this slice. Twelve migrations are applied to the isolated development and test databases. See testing/openapi-responses.md and testing/claude-builder-integration.md.

## Delivered implementation

- B0: Fastify API, generated OpenAPI, local OIDC authorization-code/PKCE provider, JWT verification, setup/dev/build/start commands and restricted database runtime credentials.
- B1: authenticated organisation/branch membership checked per transaction; tenant API isolation; durable inbox, multipart inventory checkpoints and projections, replay handling and shortage needs/alerts.
- B2: transactional quotes and approvals, exact PostgreSQL numeric pricing, version checks, budget reservations, concurrent approval idempotency, supplier intents and transactional outbox.
- B3: file-backed fake supplier, paused startup and lookup before dispatch, uncertain-outcome reconciliation, stable restored order identities, quantity-bounded idempotent receipts and budget settlement. A real disposable database dump/restore test keeps the independent supplier ledger intact.

## Acceptance and boundaries

AC-001 through AC-018 remain NOT RUN as complete acceptance gates. The integration tests are partial evidence, not completion of the acceptance plan. No client application or real supplier integration exists. The worker is a synthetic one-shot runner, not the planned durable scheduler. Receipt writeback is queued, not delivered externally.

Commercial fixtures currently use EGP cash, a named tax-exempt pricing rule and a five-minute quote lifetime. Mapping administration and supplier selection policies are not integrated. Partial approvals now preserve an open remainder; cross-branch idempotency key conflicts return 409 with rollback. Open commitments and unknown-outcome replenishment policy remain to be enforced. Local OIDC uses development interactions and ephemeral keys.

Claude's 13 domain packages are merged with reviewed feed read-boundary and refusal corrections. The domain merge passed 343 tests; the latest builder integration passes 384. Installation lifecycle is now connected to inventory authorization; other new policies still require their own runtime integration. Pure tests alone do not advance acceptance status. Review and retained RED/GREEN evidence: testing/domain-merge-review.md.

## Team and next work

GPT-6 Astra coordinates and reviews. Three earlier GPT-5.6 Sol workstreams exhausted capacity; Astra completed interrupted integration locally. Ten isolated Claude Opus 5 builder lanes stopped at the shared session limit, then resumed on 2026-09-13 after a successful capacity probe. All ten resumed sessions showed tool activity. The OpenAPI response-contract slice is now reviewed and verified locally; the other slices remain unintegrated. Later commercial-fix and independent-review sessions stopped at the shared limit and do not count as completed reviews. Claude launches are paused at the user request; the earlier Sol merge-review work is complete. Astra reviews, verifies and integrates each lane. No reset credits or paid services were used.

Installation lifecycle is now enforced in the inventory request path, including terminal revocation and locking. Concurrent synthetic supplier access, stale reconciliation and receipt rollback are covered. Next: connect guarded feed ingestion to a real worker with transactional identity and commitment-aware need updates. The separate commercial-policy branch has additional hardening, sort/filter and allocation work. Coordinator review found duplicate-offer stock counting and validation gaps; it remains unmerged pending correction. Do not overlap its packages. Preserve the transactional feed watermark and treat insufficient supplier samples as unrated.
