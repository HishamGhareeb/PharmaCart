import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const allowedDatabases = new Set(['pharmacart', 'pharmacart_test'])
const composeArgs = ['compose', '-p', 'pharmacart', '-f', 'infra/compose.yaml', 'exec', '-T', 'postgres']
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = resolve(packageDirectory, 'migrations')

function assertAllowedDatabase(database) {
  if (!allowedDatabases.has(database)) throw new Error(`Database is not allowlisted: ${database}`)
}

function runDocker(args, input = '', timeoutMilliseconds = 20_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', [...composeArgs, ...args], {
      cwd: resolve(packageDirectory, '..', '..'),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let processError
    let stdinError
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMilliseconds)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', (error) => { stdinError = error })
    child.on('error', (error) => { processError = error })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut) reject(new Error(`docker compose psql timed out after ${timeoutMilliseconds}ms`))
      else if (processError) reject(processError)
      else if (stdinError) reject(stdinError)
      else if (code === 0) resolvePromise(stdout)
      else reject(new Error(`docker compose psql failed with exit ${code}: ${stderr.trim()}`))
    })
    child.stdin.end(input)
  })
}

export async function psql(database, sql, options = {}) {
  assertAllowedDatabase(database)
  if (typeof sql !== 'string' || sql.length === 0) throw new TypeError('SQL input must be a non-empty string')
  const onErrorStop = options.onErrorStop ?? true
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 20_000
  if (typeof onErrorStop !== 'boolean') throw new TypeError('onErrorStop must be boolean')
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 60_000) {
    throw new RangeError('timeoutMilliseconds must be a positive safe integer no greater than 60000')
  }
  return runDocker(
    ['psql', '-X', '-v', `ON_ERROR_STOP=${onErrorStop ? '1' : '0'}`, '-Atq', '-U', 'pharmacart_bootstrap', '-d', database],
    sql,
    timeoutMilliseconds,
  )
}

export async function ensureTestDatabase(database = 'pharmacart_test') {
  if (database !== 'pharmacart_test') throw new Error('Only pharmacart_test may be created by this runner')
  const exists = await psql('pharmacart', `SELECT 1 FROM pg_database WHERE datname = '${database}'`)
  if (exists.trim() === '1') return false
  await psql('pharmacart', `CREATE DATABASE ${database}`)
  return true
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

export async function applyMigrations(database) {
  assertAllowedDatabase(database)
  await psql(database, `
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('pharmacart:schema-migration-ledger'));
    CREATE TABLE IF NOT EXISTS schema_migration (
      version text PRIMARY KEY,
      source_hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    );
    COMMIT;
  `)

  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const results = []
  for (const version of entries) {
    const source = await readFile(resolve(migrationsDirectory, version), 'utf8')
    const sourceHash = createHash('sha256').update(source).digest('hex')
    const recordedHash = (await psql(database, `SELECT source_hash FROM schema_migration WHERE version = ${quoteLiteral(version)}`)).trim()
    if (recordedHash === sourceHash) {
      results.push({ version, status: 'skipped', sourceHash })
      continue
    }
    if (recordedHash !== '') throw new Error(`Migration source hash changed after apply: ${version}`)

    const applyOutput = await psql(database, `
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('pharmacart:schema-migrations'));
      DO $hash_check$
      DECLARE existing_hash text;
      BEGIN
        SELECT source_hash INTO existing_hash FROM schema_migration WHERE version = ${quoteLiteral(version)};
        IF existing_hash IS NOT NULL AND existing_hash <> ${quoteLiteral(sourceHash)} THEN
          RAISE EXCEPTION 'Migration source hash changed after apply: %', ${quoteLiteral(version)};
        END IF;
      END
      $hash_check$;
      SELECT NOT EXISTS (
        SELECT 1 FROM schema_migration WHERE version = ${quoteLiteral(version)}
      ) AS should_apply \\gset
      \\if :should_apply
      ${source}
      INSERT INTO schema_migration (version, source_hash)
      VALUES (${quoteLiteral(version)}, ${quoteLiteral(sourceHash)})
      ON CONFLICT (version) DO NOTHING;
      SELECT 'applied' AS migration_status;
      \\else
      SELECT 'skipped' AS migration_status;
      \\endif
      COMMIT;
    `)
    const status = applyOutput.trim().split(/\s+/).at(-1)
    if (status !== 'applied' && status !== 'skipped') throw new Error(`Missing migration status for ${version}`)
    results.push({ version, status, sourceHash })
  }
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const database = process.argv[2] ?? 'pharmacart_test'
  if (database === 'pharmacart_test') await ensureTestDatabase(database)
  const results = await applyMigrations(database)
  for (const result of results) process.stdout.write(`${result.status} ${result.version} ${result.sourceHash}\n`)
}
