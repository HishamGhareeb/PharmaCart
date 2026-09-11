# Local database operations

Scope: synthetic PharmaCart development only, Compose project `pharmacart`, database `pharmacart`. The separate `pharmacart_test` database is disposable test data. Existing unrelated Docker projects are outside these commands.

## Start and migrate

1. Start Docker Desktop.
2. Set a generated local `PHARMACART_DB_PASSWORD` in ignored `infra/.env` if absent. Preserve the existing value once the database volume is initialized.
3. Run `npm run db:up`, then `npm run db:migrate`.
4. Run `npm run test:integration`. It seeds synthetic rows only in `pharmacart_test`.

The migration ledger records SHA-256 hashes. Reapplying an unchanged migration skips it; an altered applied migration fails. Fix forward with a new SQL migration. Do not edit ledger hashes to bypass a failure. Each migration and ledger entry commit atomically under a migration lock.

`npm run db:stop` stops the service and retains its volume. Do not remove volumes as a routine reset.

## Backup

Use Docker to write the backup inside the container, then copy it to the local workspace. This avoids binary redirection problems in PowerShell.

```powershell
New-Item -ItemType Directory -Force tmp/backups | Out-Null
docker compose -p pharmacart -f infra/compose.yaml exec -T postgres pg_dump -U pharmacart_bootstrap -d pharmacart -Fc -f /tmp/pharmacart.dump
docker compose -p pharmacart -f infra/compose.yaml cp postgres:/tmp/pharmacart.dump tmp/backups/pharmacart.dump
```

## Restore drill

Restore into a newly named local database, never over the development database. Keep order dispatch disabled during any future recovery until external outcomes have been reconciled. No dispatch worker exists in this foundation yet.

```powershell
docker compose -p pharmacart -f infra/compose.yaml exec -T postgres createdb -U pharmacart_bootstrap pharmacart_restore_check
docker compose -p pharmacart -f infra/compose.yaml exec -T postgres pg_restore -U pharmacart_bootstrap -d pharmacart_restore_check --exit-on-error /tmp/pharmacart.dump
docker compose -p pharmacart -f infra/compose.yaml exec -T postgres psql -U pharmacart_bootstrap -d pharmacart_restore_check -c "SELECT version, source_hash FROM schema_migration ORDER BY version"
```

If `pharmacart_restore_check` already exists, inspect it and choose a fresh local name instead of deleting it. These administrative commands require Docker access; the Codex sandbox may need a scoped elevation. Backups contain only the current database, not role definitions or the ignored local password file.

Verification on 2026-09-11: the backup was created and copied to tmp/backups/pharmacart.dump; restore into pharmacart_restore_check succeeded and both migration ledger entries were present. The restore-check database is retained for inspection. A passing schema restore does not satisfy AC-014's external-order recovery drill.
