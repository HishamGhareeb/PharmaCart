import { opendir } from 'node:fs/promises';

import { FEED_MANIFEST_LIMITS, type FeedManifest, type FeedManifestFile } from '../../../packages/feed-ingestion/src/feed-manifest.ts';
import {
  readDelimitedFeedRows,
  type IngestionStage,
} from '../../../packages/feed-ingestion/src/ingest-delimited-feed.ts';
import type { ContainedFileReader } from '../../../packages/transport-safety/src/path-boundary.ts';

export type FeedSnapshotReceipt = Readonly<{
  eventId: string;
  completionEventId: string;
  snapshotId: string;
  partitionId: string;
  sequence: number;
  duplicate: boolean;
  projectionRevision: number;
}>;
export type FeedSnapshotSubmission = Readonly<{
  batchKey: string;
  partitionKey: string;
  exportedAt: string;
  rows: readonly import('../../../packages/domain/src/inventory-snapshot.ts').InventoryRow[];
}>;

/**
 * A directory entry as the pass sees it. Symbolic links are kept distinct from
 * regular files rather than dropped: a link that stays inside the drop root is
 * a legitimate way to publish an export, and one that leaves it has to be
 * refused by the contained reader's real-path check, which is the only place
 * that can tell the two apart.
 */
export type FeedDirectoryEntry = Readonly<{ name: string; kind: 'file' | 'link' | 'other' }>;

export interface FeedDirectoryLister {
  list(root: string, maxFiles: number): Promise<readonly FeedDirectoryEntry[]>;
}

export interface FeedSnapshotSink {
  ingest(submission: FeedSnapshotSubmission): Promise<FeedSnapshotReceipt>;
}

export type FeedDecisionStage = 'enumeration' | 'manifest' | IngestionStage | 'persistence';

export type FeedFileDecision =
  | Readonly<{
      kind: 'accepted' | 'duplicate';
      relativePath: string;
      partitionKey: string;
      rowCount: number;
      receipt: FeedSnapshotReceipt;
    }>
  | Readonly<{
      kind: 'rejected';
      relativePath: string;
      partitionKey: string | null;
      stage: FeedDecisionStage;
      reason: string;
      detail: string;
    }>;

export type FeedPassRefusalReason = 'root_unreadable' | 'too_many_entries' | 'invalid_manifest';

export type FeedPassResult =
  | Readonly<{
      kind: 'completed';
      root: string;
      batchKey: string;
      exportedAt: string;
      decisions: readonly FeedFileDecision[];
    }>
  | Readonly<{ kind: 'refused'; reason: FeedPassRefusalReason; detail: string }>;

export type FeedPassOptions = Readonly<{
  root: string;
  manifest: FeedManifest;
  reader: ContainedFileReader;
  directory: FeedDirectoryLister;
  sink: FeedSnapshotSink;
}>;

/**
 * One bounded pass over one service-owned drop root. It lists the root once,
 * reads what the manifest declared, and stops. There is no watcher, no second
 * sweep and no retry: a file that was refused stays on disk with its refusal
 * reported, and nothing here deletes, renames or moves a source file, because a
 * worker that consumes its input cannot be re-run to reproduce what it decided.
 *
 * Every enumerated entry and every declared file produces exactly one decision.
 * Nothing is skipped silently: a bound that would truncate the work refuses the
 * whole pass instead of reading an arbitrary prefix of it.
 */
export async function runFeedPass(options: FeedPassOptions): Promise<FeedPassResult> {
  const { root, manifest, directory } = options;

  // Keep the safety boundary at the worker too: callers can construct a typed
  // object without going through readFeedManifest at runtime.
  if (!Number.isSafeInteger(manifest.maxFiles)
    || manifest.maxFiles <= 0
    || manifest.maxFiles > FEED_MANIFEST_LIMITS.maxFiles
    || manifest.files.length !== 1) {
    return { kind: 'refused', reason: 'invalid_manifest', detail: 'the worker requires one file and a finite bounded maxFiles' };
  }

  let entries: readonly FeedDirectoryEntry[];
  try {
    entries = await directory.list(root, manifest.maxFiles);
  } catch (error) {
    return { kind: 'refused', reason: 'root_unreadable', detail: message(error) };
  }

  // The bound is on what the root holds, not on what the manifest declared, and
  // exceeding it refuses the pass rather than reading the first N entries. A
  // silent truncation reads as "everything was covered" when it was not, and an
  // operator who dropped a thousand files into a root configured for eight has a
  // problem worth stopping for.
  if (entries.length > manifest.maxFiles) {
    return {
      kind: 'refused',
      reason: 'too_many_entries',
      detail: `${entries.length} entries in the drop root, ${manifest.maxFiles} allowed`,
    };
  }

  const declared = new Map(manifest.files.map((file) => [file.relativePath, file] as const));
  const present = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const decisions: FeedFileDecision[] = [];

  for (const entry of present) {
    decisions.push(await decide(entry, declared.get(entry.name), options));
  }

  for (const file of manifest.files) {
    if (!present.some((entry) => entry.name === file.relativePath)) {
      decisions.push(rejected(file.relativePath, file.partitionKey, 'enumeration', 'file_absent',
        'declared in the manifest but not present in the drop root'));
    }
  }

  return {
    kind: 'completed',
    root,
    batchKey: manifest.batchKey,
    exportedAt: manifest.exportedAt,
    decisions: Object.freeze(decisions),
  };
}

async function decide(
  entry: FeedDirectoryEntry,
  file: FeedManifestFile | undefined,
  options: FeedPassOptions,
): Promise<FeedFileDecision> {
  const { root, manifest, reader, sink } = options;

  if (entry.kind === 'other') {
    return rejected(entry.name, file?.partitionKey ?? null, 'enumeration', 'not_a_regular_file',
      'the pass reads regular files and links resolved inside the root');
  }
  if (file === undefined) {
    // Identity is a manifest decision, so a file nobody declared has no batch,
    // no partition and no export instant. It is reported and left on disk; it is
    // never opened, which is what keeps an unreadable container out of the pass.
    return rejected(entry.name, null, 'manifest', 'not_in_manifest',
      'no manifest entry declares this file');
  }

  const read = await readDelimitedFeedRows({
    root,
    relativePath: file.relativePath,
    compressed: file.compressed,
    columns: manifest.columns,
    contract: manifest.contract,
    maxInputBytes: manifest.maxInputBytes,
    maxDecompressedBytes: manifest.maxDecompressedBytes,
    delimiter: manifest.delimiter,
  }, reader);
  if (read.kind === 'rejected') {
    return rejected(file.relativePath, file.partitionKey, read.stage, read.reason, read.detail);
  }

  try {
    const receipt = await sink.ingest({
      batchKey: manifest.batchKey,
      partitionKey: file.partitionKey,
      exportedAt: manifest.exportedAt,
      rows: read.rows,
    });
    return {
      kind: receipt.duplicate ? 'duplicate' : 'accepted',
      relativePath: file.relativePath,
      partitionKey: file.partitionKey,
      rowCount: read.rows.length,
      receipt,
    };
  } catch (error) {
    // A refused write is this file's outcome, not the pass's. The transaction
    // rolled back, so nothing partial survives, and the remaining files still
    // get their turn.
    return rejected(file.relativePath, file.partitionKey, 'persistence', refusalCode(error), message(error));
  }
}

/** Reads a drop root without following anything out of it. The iterator stops
 *  after maxFiles+1 entries so a hostile or accidental large directory cannot
 *  allocate an unbounded entry list before the pass refuses it. */
export const filesystemFeedDirectory: FeedDirectoryLister = {
  list: async (root, maxFiles) => {
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || maxFiles > FEED_MANIFEST_LIMITS.maxFiles) {
      throw new Error('invalid directory entry limit');
    }
    const handle = await opendir(root);
    const entries: FeedDirectoryEntry[] = [];
    for await (const entry of handle) {
      entries.push({
        name: entry.name,
        kind: entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other',
      });
      if (entries.length > maxFiles) break;
    }
    return entries;
  },
};

function rejected(
  relativePath: string,
  partitionKey: string | null,
  stage: FeedDecisionStage,
  reason: string,
  detail: string,
): FeedFileDecision {
  return { kind: 'rejected', relativePath, partitionKey, stage, reason, detail };
}

function refusalCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'write_failed';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
