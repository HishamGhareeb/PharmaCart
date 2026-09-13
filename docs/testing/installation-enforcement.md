# Installation lifecycle enforcement at the inventory request boundary

Date: 2026-09-12. Branch: claude/installation-enforcement. Slice: enforce the existing
`packages/installation-lifecycle` policy on the authenticated `POST /v1/inventory` path.

Before this slice the policy was implemented and unit-tested but wired to nothing
(docs/installation-lifecycle.md, section 5). The database knew two statuses, `active` and
`revoked`, and the request path used `pharmacart_active_installation`, which hides status
behind an empty result and therefore cannot tell "never paired" from "revoked".

## 1. What changed

| File | Change |
| --- | --- |
| packages/db/migrations/0011_installation_lifecycle.sql | Forward migration: four statuses, persisted lifecycle fields, terminal-revocation trigger, narrow security-definer lookup |
| packages/db/src/installation.ts | New. Maps the stored row to the domain `Installation` and turns `authoriseInstallation` into a refusal or null |
| packages/db/src/inventory.ts | `ingestInventory` authorises `submit_inventory` against live stored status before any write, and rechecks after the inventory lock |
| packages/db/test/installation.test.ts | New. OIDC + API + PostgreSQL integration evidence (not yet run; see section 4) |
| packages/db/test/installation-policy.test.ts | New. Database-free statement-ordering regression for the same policy |
| docs/testing/installation-enforcement.md | This record |

No package.json, lockfile, API source, contract or other documentation was edited. The HTTP
contract is unchanged: a denial is still `403` with code `INSTALLATION_DENIED`, and the
response body still discloses neither the status nor the existence of any installation.

### Migration 0011

- `status` now accepts `pending`, `active`, `suspended`, `revoked`. The migration is forward
  only; it drops and replaces the two-value check rather than rewriting 0004.
- Adds the minimum the domain `Installation` type needs: `paired_at`, `status_changed_at`,
  `status_reason`, `supersedes_installation_id`.
- **Legacy defaults are explicit, not invented.** Rows that predate the migration keep
  `paired_at IS NULL` and receive `status_changed_at = 1970-01-01T00:00:00Z` as a marker. No
  historic pairing instant is fabricated. The column default is then moved to `now()` so rows
  created from here on record the real instant.
- `pharmacart_installation_lifecycle(text)` is `SECURITY DEFINER` with `SET search_path =
  pg_catalog`, revoked from `PUBLIC` and granted only to `pharmacart_runtime`. It takes the
  authenticated subject and returns at most that subject's own row, including status. There is
  no variant that lists or filters installations, so no caller can enumerate the table or name
  another installation's scope. Organisation verification stays in the predicate, and the
  existing RLS policies on `connector_installation` are untouched.
- The lookup takes `FOR SHARE OF i`. That is what serialises a request against a concurrent
  status change: a revoking transaction cannot commit underneath an accepted write, and a
  request that arrives while a revocation is in flight waits and then observes the new status.
  The lock is taken with the definer's privileges, so `pharmacart_runtime` keeps `SELECT` only
  on `connector_installation` — it still has no `INSERT`, `UPDATE` or `DELETE`.
- `connector_installation_terminal_revocation` is a `BEFORE UPDATE` trigger fired only when
  the stored row is already `revoked`; it refuses any transition out of it. Administrative
  fixture setup of legal transitions (`pending → active`, `active → suspended`, `suspended →
  active`, and revocation from any live state) is unaffected, as is non-resurrecting
  maintenance of a revoked row such as amending `status_reason`.

### Request path

`ingestInventory` now:

1. reads the live stored lifecycle through the new lookup, which takes the row share lock;
2. calls `authoriseInstallation(installation, 'submit_inventory')` **before** the inbox,
   projection, need, alert or `inventory_state` writes, denying `pending`, `suspended`,
   `revoked` and an absent or unverified installation;
3. derives installation, organisation and branch identifiers from the stored row only — the
   request body and tenant selector headers cannot move the write;
4. rechecks the lifecycle after waiting for the per-installation `inventory_state` lock, so a
   request queued behind an earlier one re-reads status rather than trusting its first read.

The refusal carries the stored status, the domain refusal reason and the `syncDirective`
(`pause` for `pending`/`suspended`, `stop` for `revoked`) on the thrown `InventoryError`.
That is recorded for a future connector-facing surface; **nothing exposes it over HTTP**. No
endpoint was added, and no connector queue or health support is claimed.

## 2. TDD evidence: database-free policy test

`packages/db/test/installation-policy.test.ts` drives `ingestInventory` against a recording
client that stands in for PostgreSQL, so statement order around authorisation, the lock and
the recheck is asserted directly. It is picked up by the existing `packages/db/test/*.test.ts`
globs in `test:integration` and `test:coverage`; no glob was changed.

RED, before any implementation change:

```
$ node --experimental-strip-types --test packages/db/test/installation-policy.test.ts
✖ AC-016: a lifecycle that does not permit submit_inventory is denied before any write (3.088ms)
✖ AC-016: the denial carries the stored status and its sync directive (0.9176ms)
✖ AC-016: an active installation is authorised from stored scope and rechecked after the lock (0.3031ms)
✖ AC-016: a revocation observed after the inventory lock stops the pending write (1.6261ms)
ℹ tests 4
ℹ pass 0
ℹ fail 4
```

Failure reasons, in order: no lifecycle lookup was issued at all (`0 !== 1` lookups); the
denial carried no refusal detail (`undefined`); an active installation was denied because the
old code only queried `pharmacart_active_installation` (`Error: INSTALLATION_DENIED` from
inventory.ts:15); and no `FOR UPDATE` statement preceded a recheck.

GREEN, after the implementation:

```
$ node --experimental-strip-types --test packages/db/test/installation-policy.test.ts
✔ AC-016: a lifecycle that does not permit submit_inventory is denied before any write (4.0866ms)
✔ AC-016: the denial carries the stored status and its sync directive (0.8525ms)
✔ AC-016: an active installation is authorised from stored scope and rechecked after the lock (1.297ms)
✔ AC-016: a revocation observed after the inventory lock stops the pending write (0.8058ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

## 3. Independent checks run in this worktree

```
$ npm run typecheck          # tsc --noEmit, no output, exit 0
$ npm run lint               # eslint ., no output, exit 0
$ npm run contracts:verify   # contracts verified
$ npm test                   # ℹ tests 324  ℹ suites 55  ℹ pass 324  ℹ fail 0  (duration_ms 6319.5919)
```

`npm test` covers the 324 unit/contract tests of the main baseline and is unchanged by this
slice; its glob does not include `packages/db/test`. Together with the four new policy tests
that is 328 non-database tests passing here.

## 4. Database tests: written, NOT YET RUN

`packages/db/test/installation.test.ts` is complete but **has not been executed**, and no
migration has been applied anywhere. Local PostgreSQL is shared through the isolated
`pharmacart` Compose project, and running it here would both contend with other work and
record migration 0011's source hash before review — after which the hash may not change. Its
RED and GREEN are therefore reserved for the coordinator. Nothing in this document reports a
database result that was not observed.

Command reserved for the coordinator (resets synthetic tables in `pharmacart_test` only):

```
npm run test:integration
```

Note that these tests fail before the migration is applied, which is the RED: the lookup
function and the four-state check constraint do not exist yet.

The three integration tests assert:

1. **Lifecycle denial and acceptance.** A `pending` installation is denied `403` /
   `INSTALLATION_DENIED` with inbox, projection and revision counts at zero and no pairing
   instant invented; after pairing is confirmed the same event is accepted; a `suspended`
   installation is denied with counts unchanged; after resume the queued event is accepted;
   after revocation both a new event and a completion are denied with counts unchanged;
   resurrection to `active`, `pending` or `suspended` is refused by the database while
   non-resurrecting maintenance succeeds; and the lookup returns exactly one row for the
   subject while two installations exist.
2. **Subject scope spoofing.** A forged `installationId` in the body is off contract (`400`);
   tenant selector headers do not move the write, which still lands in the token subject's own
   organisation and branch; a revoked second installation is denied even though an active one
   exists in the same table; and a human member subject with no installation is denied.
3. **In-flight revocation and least privilege.** A revoking transaction holds the installation
   row (observed through an advisory marker lock) while the next request arrives; that request
   is denied `403` and adds no rows. Privilege assertions: the lookup is `SECURITY DEFINER`
   with `search_path=pg_catalog`, executable by `pharmacart_runtime` and not by `PUBLIC`; the
   runtime holds `SELECT` and not `UPDATE`/`INSERT`/`DELETE` on `connector_installation`; the
   status check lists the four states; and only one `pharmacart_installation%` function exists.

## 5. Boundary and known limits

- **AC-016 remains NOT RUN.** The criterion also names connector health and queue state.
  Neither exists: the connector is not implemented, there is no queue to inspect and no
  endpoint reports a sync directive. This slice is the request-boundary half only, and its
  integration evidence is still pending execution.
- Membership revocation for human users remains a separate surface
  (`pharmacart_active_membership`). The two authorisation paths still have not converged.
- Denials do not distinguish "no installation" from "organisation not verified"; both surface
  as `installation_unknown`. That non-disclosure is deliberate and matches prior behaviour.
- `pharmacart_active_installation` is left in place for compatibility and is now unused by the
  request path. Removing it is a separate decision for the coordinator.
- The row share lock makes an inventory request wait for an in-flight status change. There is
  no `lock_timeout`, so the wait is bounded only by the revoking transaction; an
  administrative transaction left open would stall ingestion for that installation.
- Re-pairing is not implemented in the database. `supersedes_installation_id` is persisted and
  self-reference is refused, but `user_subject` is still globally unique, so a replacement
  installation needs a new subject credential. `repairInstallation` remains pure-domain only.
- Capabilities are still fixed per status in code rather than granted per installation.
- Only `submit_inventory` is enforced. Order submission and receipt acknowledgement do not yet
  consult the lifecycle.
