import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { psql } from './postgres.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentPath = resolve(packageDirectory, '..', '..', 'infra', '.env');
const passwordKey = 'PHARMACART_RUNTIME_DB_PASSWORD';

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function readValue(source, key) {
  for (const line of source.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && line.slice(0, separator).trim() === key) return line.slice(separator + 1).trim();
  }
  return undefined;
}

async function ensureRuntimePassword() {
  const source = await readFile(environmentPath, 'utf8');
  const existing = readValue(source, passwordKey);
  if (existing !== undefined && existing !== '') return existing;
  const generated = randomBytes(32).toString('base64url');
  const suffix = source.endsWith('\n') ? '' : '\n';
  await writeFile(environmentPath, `${source}${suffix}${passwordKey}=${generated}\n`, { mode: 0o600 });
  return generated;
}

export async function configureRuntimeLogin(database = 'pharmacart_test') {
  const password = await ensureRuntimePassword();
  await psql(database, `ALTER ROLE pharmacart_app LOGIN PASSWORD ${quoteLiteral(password)}`);
  return {
    connectionString: `postgresql://pharmacart_app:${encodeURIComponent(password)}@127.0.0.1:55432/${database}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await configureRuntimeLogin(process.argv[2] ?? 'pharmacart_test');
  process.stdout.write('Runtime database login configured.\n');
}

