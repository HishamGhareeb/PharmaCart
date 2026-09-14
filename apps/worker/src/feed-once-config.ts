import { open } from 'node:fs/promises';
import path from 'node:path';

import { FEED_SINK_LIMITS } from '../../../packages/db/src/feed-sink.ts';
import { readFeedManifest, type FeedManifestDecision } from '../../../packages/feed-ingestion/src/feed-manifest.ts';

/**
 * Startup configuration for one synthetic, local feed pass. Everything the pass
 * needs is validated here, before a database pool exists or a drop root is
 * listed, so a misconfigured run stops with a named reason instead of partway.
 */
export type FeedOnceConfig = Readonly<{
  manifestPath: string;
  root: string;
  lockTimeoutMs: number;
}>;

export type FeedOnceConfigRefusalReason =
  | 'production_environment'
  | 'missing_database_url'
  | 'unknown_argument'
  | 'duplicate_argument'
  | 'missing_value'
  | 'missing_argument'
  | 'invalid_lock_timeout';

export type FeedOnceConfigDecision =
  | Readonly<{ kind: 'valid'; config: FeedOnceConfig }>
  | Readonly<{ kind: 'invalid'; reason: FeedOnceConfigRefusalReason; detail: string }>;

export type FeedManifestFileRejectionReason = 'manifest_unreadable' | 'manifest_too_large' | 'manifest_not_json';

export type FeedManifestFileDecision =
  | FeedManifestDecision
  | Readonly<{ kind: 'rejected'; reason: FeedManifestFileRejectionReason; detail: string }>;

export const FEED_ONCE_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxLockTimeoutMs: FEED_SINK_LIMITS.maxLockTimeoutMs,
});

const ARGUMENTS = Object.freeze({ '--manifest': 'manifestPath', '--root': 'root' } as const);
const WHOLE_MILLISECONDS = /^[1-9][0-9]{0,5}$/;

export function parseFeedOnceConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): FeedOnceConfigDecision {
  if (env['NODE_ENV'] === 'production') {
    return invalid('production_environment', 'the feed pass is synthetic development only');
  }
  const databaseUrl = env['PHARMACART_RUNTIME_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    return invalid('missing_database_url', 'PHARMACART_RUNTIME_DATABASE_URL is required');
  }

  const values: Partial<Record<'manifestPath' | 'root', string>> = {};
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at]!;
    if (!Object.hasOwn(ARGUMENTS, flag)) return invalid('unknown_argument', flag);
    const key = ARGUMENTS[flag as keyof typeof ARGUMENTS];
    if (values[key] !== undefined) return invalid('duplicate_argument', flag);
    const value = argv[at + 1];
    if (value === undefined || value === '' || value.startsWith('--')) return invalid('missing_value', flag);
    values[key] = value;
  }
  if (values.manifestPath === undefined) return invalid('missing_argument', '--manifest');
  if (values.root === undefined) return invalid('missing_argument', '--root');

  const lockTimeout = env['PHARMACART_FEED_LOCK_TIMEOUT_MS'];
  let lockTimeoutMs: number = FEED_SINK_LIMITS.defaultLockTimeoutMs;
  if (lockTimeout !== undefined) {
    const parsed = WHOLE_MILLISECONDS.test(lockTimeout) ? Number(lockTimeout) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed > FEED_ONCE_LIMITS.maxLockTimeoutMs) {
      return invalid('invalid_lock_timeout', `PHARMACART_FEED_LOCK_TIMEOUT_MS must be 1 to ${FEED_ONCE_LIMITS.maxLockTimeoutMs}`);
    }
    lockTimeoutMs = parsed;
  }

  return {
    kind: 'valid',
    config: Object.freeze({
      manifestPath: path.resolve(values.manifestPath),
      root: path.resolve(values.root),
      lockTimeoutMs,
    }),
  };
}

/**
 * Reads the operator's manifest with a byte ceiling, then applies the same
 * validation the worker relies on, including the synthetic-subject rule.
 */
export async function loadFeedManifestFile(manifestPath: string): Promise<FeedManifestFileDecision> {
  let bytes: Uint8Array;
  try {
    const handle = await open(manifestPath, 'r');
    try {
      const buffer = new Uint8Array(FEED_ONCE_LIMITS.maxManifestBytes + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      bytes = buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { kind: 'rejected', reason: 'manifest_unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (bytes.length > FEED_ONCE_LIMITS.maxManifestBytes) {
    return { kind: 'rejected', reason: 'manifest_too_large', detail: `more than ${FEED_ONCE_LIMITS.maxManifestBytes} bytes` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'rejected', reason: 'manifest_not_json', detail: manifestPath };
  }
  return readFeedManifest(parsed);
}

function invalid(reason: FeedOnceConfigRefusalReason, detail: string): FeedOnceConfigDecision {
  return { kind: 'invalid', reason, detail };
}
