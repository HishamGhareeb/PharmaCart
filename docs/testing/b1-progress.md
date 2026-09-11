# B1 execution evidence — 2026-09-12

After B0, `node --test packages/db/test/api.test.ts` failed because the tenant API implementation did not exist (checkpoint a6f4d0a). After implementation the same test passes with a real loopback OIDC authorization-code flow and PostgreSQL runtime login. It verifies own read, foreign/missing 404, missing-token 401, forged scope 403, membership revocation and branch removal on the next request, and unchanged private rows. Separate runtime tests force pool reuse and context cleanup.

`node --test packages/db/test/inventory.test.ts` failed because durable ingestion did not exist (checkpoint ebdf0a8). After implementation it exposed a real PostgreSQL `22P05 unsupported Unicode escape sequence` failure: domain snapshot keys use NUL separators that jsonb rejects. Forward migration 0005 stores the internal restart checkpoint as JSON text; normalized projections remain queryable. Applied migration 0004 was not edited.

The same inventory integration test now passes: real connector token, duplicate concurrent posts, rebuilding the API, two inbox events with one projection revision, changed-body conflict, incomplete second snapshot retaining prior quantity 8 as stale, forbidden payload installation selector and next-request installation revocation. Existing needs remain unchanged; the reserved alert table is empty. Automatic needs and alerts are not implemented, so this is partial AC-003 evidence, not a full alert/need workflow acceptance claim.

AC-001 and AC-004 have executable API/database evidence. AC-002 still requires a mapping-to-quote scenario in B2. Acceptance status will be reconciled after the full serialized suite and retained run output. No browser/device or supplier behavior is established here.
