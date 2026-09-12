# PharmaCart current build status

Date: 2026-09-12. Current implementation status; historical evidence is under docs/testing.

Latest B3 verification: 96 tests pass (77 unit/contract and 19 PostgreSQL integration). Combined coverage: 94.92% lines, 84.14% branches, 91.98% functions. Type checking, lint, generated contracts and build passed during this slice. Ten migrations are applied locally. See testing/b3-progress.md.

## Delivered implementation

- B0: Fastify API, generated OpenAPI, local OIDC authorization-code/PKCE provider, JWT verification, setup/dev/build/start commands and restricted database runtime credentials.
- B1: authenticated organisation/branch membership checked per transaction; tenant API isolation; durable inbox, multipart inventory checkpoints and projections, replay handling and shortage needs/alerts.
- B2: transactional quotes and approvals, exact PostgreSQL numeric pricing, version checks, budget reservations, concurrent approval idempotency, supplier intents and transactional outbox.
- B3: file-backed fake supplier, paused startup and lookup before dispatch, uncertain-outcome reconciliation, stable restored order identities, quantity-bounded idempotent receipts and budget settlement. A real disposable database dump/restore test keeps the independent supplier ledger intact.

## Acceptance and boundaries

AC-001 through AC-018 remain NOT RUN as complete acceptance gates. The integration tests are partial evidence, not completion of the acceptance plan. No client application or real supplier integration exists. The worker is a synthetic one-shot runner, not the planned durable scheduler. Receipt writeback is queued, not delivered externally.

Commercial fixtures currently use EGP cash, a named tax-exempt pricing rule and a five-minute quote lifetime. Mapping administration and supplier selection policies are not integrated. Partial-need fulfilment and cross-branch idempotency key collision handling require further review before claiming B2 complete. Open commitments and unknown-outcome replenishment policy remain to be enforced. Local OIDC uses development interactions and ephemeral keys.

Claude's domain packages are awaiting reviewed integration on this branch. Their pure tests alone will not advance acceptance status.

## Team and next work

GPT-6 Astra coordinates and reviews. Three GPT-5.6 Sol workstreams exhausted capacity; Astra completed interrupted integration locally. No reset credits or paid services were used.

Next: commit B3, review and merge claude/domain-packages, verify the combined tree, then enforce installation lifecycle at the request boundary and connect guarded feed ingestion to a real worker. Preserve the transactional feed watermark and treat insufficient supplier samples as unrated.
