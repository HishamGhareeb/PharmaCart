# Three Claude Opus 5 implementation lanes

Date: 2026-09-12. Coordinator: GPT-6 Astra. Model observed in streamed builder output: claude-opus-5. Each builder used an isolated worktree with exclusive file ownership. No Fable run was needed.

## Review and evidence

Installation: reviewed migration 0011, stored-scope adapter, inventory enforcement and tests before copying into the integration tree. The security-definer lookup has fixed search_path, no PUBLIC execute, and locks only the subject-bound installation. Runtime status writes remain forbidden. The coordinator reproduced four policy test failures against the old implementation (installation-coordinator-red.txt). The database run passed lifecycle denial and revocation serialization but caught an invalid synthetic OIDC test subject; the test now pairs an existing allowlisted synthetic subject to installation B. No production identity behavior was loosened.

Procurement: reviewed exact PostgreSQL remainder accounting and organisation-scoped idempotency conflict refusal. Coordinator PostgreSQL RED reproduced two actual assertion failures: a half-approved need became covered|2|2 instead of open|2|1, and a cross-branch key collision returned HTTP 500 instead of 409 (procurement-coordinator-red.txt). After implementation both database tests passed, including concurrency, replay and rollback assertions. Migration 0012 contains documentation comments only.

Orders: reviewed stale-lookup version checks, conditional unknown-outcome event emission, and cross-process synthetic ledger locking. Review found that NaN/Infinity lock options and a backwards wall clock could defeat bounded waiting. Claude corrected these with constructor validation and monotonic elapsed time, recording actual RED/GREEN in order-recovery-concurrency.md. The coordinator database run passed all six new worker/receipt scenarios. Tests include receipt rollback after a later-line refusal and concurrent receipt settlement.

Builder-local reports clearly distinguish unit checks from unrun database tests. Coordinator integration tests are sequential against pharmacart_test only. An initial database attempt failed because Docker was stopped; that environment failure is not represented as behavioral RED. Docker Desktop and the isolated pharmacart Compose service were restarted without resetting volumes.

## Remaining boundaries

AC-001 through AC-018 retain their previous NOT RUN status as complete gates. Installation enforcement covers inventory requests; connector health, queue behavior and re-pairing remain unimplemented. Open-need quantities now represent a remainder, but a later inventory target recalculation must account for outstanding and unknown commitments before the end-to-end replenishment loop can be claimed safe. Synthetic lock markers left by a dead process require an operator decision; they are never broken solely by age. Real supplier certification, writeback delivery and client applications remain outside these slices.

Final combined verification: 365 tests passed, zero failures. Coverage: 96.46% lines, 89.41% branches, 96.10% functions. The count comprises 335 unit/contract/policy tests and 30 real PostgreSQL cases (the dedicated database glob also includes four database-free policy tests). Typecheck, lint, contracts:verify and build passed; npm audit reported zero vulnerabilities. Full output: claude-builder-coverage.txt.
