# B0 executable foundation evidence

Historical first increment. For current results see foundation-integration.md and ../STATUS.md.

Date: 2026-09-11. Coordinator: GPT-6 Astra. Implementers: two GPT-5.6 Sol agents.

## Delivered

- Root package manifest, dependency-free lockfile, Node pin and repeatable test/coverage commands.
- Decimal refinements, strict approval input validation and a typed submission follow-up decision table.
- Deterministic synthetic graph: two pharmacies, two suppliers, four pharmacy branches, memberships, thirty packs, scoped offers and partial-snapshot scenarios.
- Isolated digest-pinned PostgreSQL Compose service; generated password stored only in ignored infra/.env; loopback port 55432.

## Actual verification

- `npm ci --ignore-scripts --offline`: success.
- `npm test`: 23 passed, 0 failed, 0 skipped.
- `npm run test:coverage`: 23 passed; four exercised implementation modules report 100% lines, branches and functions. Configured thresholds are 80%. This small-module coverage is not product-wide coverage.
- `npm audit --offline`: zero vulnerabilities reported with no third-party dependencies; this is not an online security assessment.
- `docker compose -p pharmacart -f infra/compose.yaml up -d --wait`: healthy after allowing 120 seconds for first initialization.
- SQL `select version()`: PostgreSQL 17.10.
- `git check-ignore infra/.env` with a per-command safe.directory override: secret file ignored.

## Limits and next work

B0 remains incomplete. No AC-001 through AC-018 has passed. No API, authentication, RLS, migrations, generated OpenAPI schemas, arithmetic engine, durable outbox, fake supplier service or application clients exist yet. TypeScript is executed using native stripping, not statically typechecked. Lint, static typechecking, integration and E2E runners remain to be installed/configured.

The submission helper consumes trusted typed adapter evidence. It neither validates untrusted network responses nor proves that an adapter's not-found outcome is authoritative. Those checks belong to future adapter certification and worker integration. Fixture tests prove fixture structure, not real mapping, snapshot or tenant-isolation behavior.

Next bounded assignments: schema generation/typechecking and database migrations with non-owner runtime role and tenant-isolation tests. Astra reviews shared interfaces before API implementation.

Agent RED/GREEN notes are in contracts.tdd.md and fixtures.tdd.md. Git checkpoint commits were not created; do not treat this run as having the TDD skill's full checkpoint evidence.

## Self-evaluation

Using the agent-self-evaluation rubric: accuracy 4/5 (executed unit and SQL evidence, static typing pending); completeness 4/5 (bounded foundation delivered, B0 gaps enumerated); clarity 4/5 (commands and scope explicit, multiple design documents remain); actionability 5/5 (repeatable local commands); conciseness 4/5 (necessary evidence retained). Average 4.2/5.

Highest-impact improvements: add static type/schema checks; implement real PostgreSQL isolation tests; consolidate status as milestones land. Would the user agree? Likely for this foundation increment, not as a completed application claim.
