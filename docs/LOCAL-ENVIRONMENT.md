# Local environment observations

Checked 2026-09-11.

- Node: v24.19.0 available.
- npm: 11.17.0 available.
- Docker engine 29.7.2 is running. Sandbox pipe access is denied; elevated local Docker commands succeed.
- PharmaCart PostgreSQL 17.10 is healthy in the isolated pharmacart Compose project at 127.0.0.1:55432; SQL version query succeeded.
- dotnet command available; `dotnet --list-sdks` returned no SDK entries.
- Git requires a per-command safe.directory override for this checkout's owner mismatch. No global Git configuration was changed.

Node and npm are pinned in package.json; the locally available PostgreSQL image is pinned by digest in infra/compose.yaml. These establish a local foundation, not a production support matrix. Ten SQL isolation/migration integration tests pass; authenticated API integration is pending. Windows service builds have not run. A local database backup was restored successfully to pharmacart_restore_check with both migration ledger entries intact.
