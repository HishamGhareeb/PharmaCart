# Deployment readiness gate

User requirement, 2026-09-13: implementation must be suitable for rigorous deployment review. Parallelism does not relax review, verification or acceptance gates. This file establishes the gate; it does not claim the current build has passed it or authorize deployment.

## Required evidence

- Every builder diff is reviewed before integration; input validation, tenant/role authority, secrets, exact quantities, idempotency and failure paths are checked at real boundaries.
- New behavior has retained RED/GREEN evidence. Unit simulations are distinguished from PostgreSQL, HTTP, filesystem, process restart and browser tests. Required acceptance criteria pass only with their named end-to-end evidence.
- Clean installation, types, lint, generated contracts, meaningful coverage and application builds pass on the integrated revision. New dependencies are pinned and audited. A clean-checkout verification must precede a release candidate.
- Concurrent requests/workers, delayed responses, timeouts, process crashes, database restore and replay must preserve financial/stock identities and avoid duplicate external effects. All configurable resource bounds are validated; retry/lock waits are finite.
- Migrations have reviewed forward behavior, measured compatibility and a tested backup/recovery plan. Production data migration and rollback drills require a separately authorized environment.
- Browser purchase flows cover authentication, CSRF, permissions, error/retry states and explicit approvals, plus required accessibility/locale paths. Tokens and secrets are absent from browser storage/bundles and retained logs.
- Operational configuration validates at startup. Dependency readiness, structured redacted logs, bounded workers, failure visibility and recovery procedures are demonstrated. Load and fault tests need stated workload and pass thresholds before a capacity claim.

## Current release blockers

This remains a local synthetic build. Development OIDC interactions and ephemeral identity/session state are not production identity infrastructure. Real supplier contracts/certification, proven receipt-to-inventory inclusion, durable connector/service integration, complete browser/client acceptance, production observability/capacity and deployment/recovery configuration are not yet verified. All AC-001 through AC-018 retain their recorded status; passing a package or integration subset does not override the acceptance plan.

An applied synthetic receipt writeback is not proof that a later inventory snapshot contains that receipt. Replenishment must hold or require explicit inclusion evidence; otherwise it can double-count stock or reorder already-committed quantities. This dependency is reviewed across the need, feed and writeback lanes before any of them is described as a complete replenishment loop.

A formal local production-readiness audit is performed after integration and acceptance evidence is available, using the production-audit skill. It must list evidence and unresolved blockers, and cannot confer supplier, regulatory or operational certification. No publication, real purchasing or production action occurs without separate user authorization.
