# B0 continuation evidence — 2026-09-12

Baseline before edits: npm ci succeeded; typecheck, lint, contracts:verify and coverage passed (54 tests; 96.44% lines, 90.17% branches, 97.10% functions). The sandbox denied Docker pipe access; the same integration command with scoped elevation passed all 10 PostgreSQL tests. This was an environment failure, not a RED business test.

Fresh GPT-5.6 Sol agents owned API/OpenAPI, OIDC, and runtime DB modules exclusively. All three hit the account usage limit before delivery. Astra reviewed their files and completed the interrupted work locally. No reset credit was consumed. Review corrected a test-only obsolete jose type, an invalid boolean concatenation in runtime test SQL, and TypeScript declarations for administrative scripts. Migration 0002 already supplies pharmacy_owner; no role migration rewrite was needed.

## Executed evidence

| Guarantee | RED | GREEN |
| --- | --- | --- |
| OIDC verifier/provider exist | node --test packages/auth/test/verify-access-token.test.ts infra/oidc/provider.test.ts: both missing implementation imports failed | Same targets: 12 passing tests |
| OpenAPI available over API | node --test apps/api/test/openapi.test.ts: 404 versus expected 200 | Coverage suite includes passing endpoint equality test |
| API correlation, strict validation and redacted errors | Sol's pre-implementation output was not retained; no RED claim | 9 API injection tests pass |
| Restricted PostgreSQL runtime and per-request membership | Interrupted agent left implementation; no original RED claim | 5 real PostgreSQL tests pass, including revocation and pool reuse |
| Actual OIDC authorization-code PKCE flow | Additional integration verification, not a new implementation RED | Local HTTP discovery/login/consent/token exchange and JWT validation pass; ID token rejected |
| Compiled application runs | Build/smoke verification | npm run build; compiled Fastify server listened on loopback and GET /health returned 200 |

Full unit/API/OIDC/contract run: 77 tests pass; coverage thresholds pass. Typecheck and lint pass. Serialized PostgreSQL suite: 15 tests pass. Development migration 0003 applied and runtime login configured; existing migration hashes preserved. npm audit: zero vulnerabilities.

Local OIDC intentionally uses ephemeral keys, in-memory sessions and development interactions for two invented accounts. It refuses production mode and non-loopback issuers. It is not production identity infrastructure. These checks finish the runnable B0 backend foundation; no AC-001 through AC-018 is established by this evidence.

GitHub foundation commit c191cb0 was pushed to main after explicit user authorization. Subsequent work is on codex/b0-b3-synthetic-loop. TDD test checkpoints dbc6b96 and 28d0192 retain missing OIDC and missing OpenAPI evidence.
