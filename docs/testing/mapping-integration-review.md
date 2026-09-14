# Manual mapping integration review

Date: 2026-09-13. Source reviewed from `tmp/claude-mapping`; copied into the assigned root paths unchanged.

## Copied files

- `packages/db/src/mapping.ts`
- `packages/db/test/mapping.test.ts`
- `packages/db/migrations/0015_manual_mapping.sql` (LF-normalized, unapplied)
- `apps/api/src/mapping-routes.ts`
- `apps/api/test/mapping-routes.test.ts`

## Review findings

The mapping core enforces explicit human selection, complete verified catalogue identity, exact sale-unit equality, bounded candidate disclosure, pharmacy owner/purchaser read access, and owner-only writes. Repository writes lock the need, check the expected version and open status, append a source mapping and provenance row, and preserve repeat-versus-stale semantics.

Migration 0015 carries organisation and branch through the need and mapping/product foreign keys, preventing RLS-bypassing provenance inserts from crossing tenant lineage or claiming a different product. It enables forced RLS and least-privilege grants on the new provenance table. The migration remains unapplied pending coordinator sequencing with 0013/0014.

One documentation caveat was recorded during review: migration 0008 already grants `UPDATE(id)` on `source_product_map` for row-lock compatibility. Migration 0015 adds only `INSERT`; it does not revoke that pre-existing column privilege. No change was made because removing it may break existing `FOR SHARE` paths and is outside this lane.

## Validation

- `node --experimental-strip-types --test apps/api/test/mapping-routes.test.ts`: PASS, 9/9.
- `node --experimental-strip-types --test packages/db/test/mapping.test.ts`: BLOCKED before test setup by Docker access (`permission denied while trying to connect to the docker API`). No database assertion is claimed.
- `npm run lint`: PASS.
- `npm run typecheck`: FAIL on pre-existing missing `packages/db/src/feed.ts` imports in `apps/worker/src/feed-worker.ts`; no mapping diagnostics were reported.
- No migration apply, database reset, Docker startup, route registration, package/script edit, commit, or push was performed.

## Integration hooks

Coordinator should register `registerMappingRoutes(app, pool, verifier)` inside `buildTenantApi`, apply 0015 after reserved migrations 0013/0014, then run the serialized integration/coverage checks. The mapping database test currently self-registers the module on a built app and is intentionally awaiting coordinator database execution. AC-001/AC-002 remain unpassed until those checks execute against PostgreSQL.


## Coordinator database verification

Reviewed additive migrations 0013, 0014 and 0015 were applied in order to pharmacart_test only. The first mapping database run passed three cases and failed the candidates case at OIDC login: the fixture used unsupported synthetic:user:c. The fixture now reuses allowed synthetic:user:b with a separate purchaser membership in A; no authentication rule changed. Rerunning only that case passed. All four database cases therefore have passing evidence, including direct runtime provenance inserts against foreign needs and mismatched products. Original failure retained in tmp/mapping-integration-db.txt; targeted pass in tmp/mapping-candidates-recheck.txt. Development migrations remain at 0012. API registration and OpenAPI descriptions are still pending.

Update 2026-09-14: registration and OpenAPI descriptions are done in `api-registration-openapi.md`; `mappingApi` no longer re-registers the module.

