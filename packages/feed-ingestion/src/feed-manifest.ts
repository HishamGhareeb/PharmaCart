import path from 'node:path';

import type {
  InventoryAdapterContract,
  SourceCodeNormalization,
} from '../../transport-adapters/src/inventory-adapter.ts';
import type { TransportColumnMap } from '../../transport-adapters/src/transport-result.ts';
import { resolveContainedPath } from '../../transport-safety/src/path-boundary.ts';

/**
 * The manifest is trusted service configuration, not feed input. It exists so
 * that the two things a dropped file cannot be trusted to tell us about itself —
 * when it was exported and which batch it belongs to — come from an operator
 * decision rather than from a filesystem timestamp. A modified time changes when
 * a file is copied, so using it as identity would mint a new snapshot for the
 * same stock and count it twice.
 */
export type FeedManifestFile = Readonly<{
  relativePath: string;
  partitionKey: string;
  format: 'delimited';
  compressed: boolean;
}>;

export type FeedManifest = Readonly<{
  installationSubject: string;
  batchKey: string;
  exportedAt: string;
  maxFiles: number;
  maxInputBytes: number;
  maxDecompressedBytes: number;
  delimiter: string;
  columns: TransportColumnMap;
  contract: InventoryAdapterContract;
  files: readonly FeedManifestFile[];
}>;

export type FeedManifestRejectionReason =
  | 'not_an_object'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_exported_at'
  | 'invalid_byte_limit'
  | 'invalid_file_count'
  | 'too_many_files'
  | 'no_files'
  | 'unsupported_format'
  | 'unsafe_relative_path'
  | 'duplicate_partition_key'
  | 'duplicate_relative_path'
  | 'non_synthetic_subject';

export type FeedManifestDecision =
  | Readonly<{ kind: 'accepted'; manifest: FeedManifest }>
  | Readonly<{ kind: 'rejected'; reason: FeedManifestRejectionReason; detail: string }>;

/**
 * Ceilings the operator may lower but never raise. The input ceiling matches the
 * compressed-input cap inside `gunzipWithinBudget`, and the output ceiling its
 * decompressed cap, so a manifest cannot ask the reader for a budget the
 * decompression guard would refuse anyway.
 */
export const FEED_MANIFEST_LIMITS = Object.freeze({
  maxFiles: 1024,
  maxInputBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
});

const SYNTHETIC_SUBJECT_PREFIX = 'synthetic:';
const NORMALIZATIONS: readonly string[] = ['exact', 'trim', 'trim_upper'];
/** Any root works: `resolveContainedPath` is a string-level guard and the real
 *  root is re-checked by the reader. Declaring a traversal path is a manifest
 *  authoring mistake, and naming it here is cheaper than naming it per pass. */
const PATH_VALIDATION_ROOT = path.resolve('feed-manifest-validation');

export function readFeedManifest(value: unknown): FeedManifestDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject('not_an_object', typeof value);
  }
  const source = value as Record<string, unknown>;

  const installationSubject = requiredText(source, 'installationSubject');
  if (typeof installationSubject !== 'string') return installationSubject;
  if (!installationSubject.startsWith(SYNTHETIC_SUBJECT_PREFIX)) {
    return reject('non_synthetic_subject', installationSubject);
  }

  const batchKey = requiredText(source, 'batchKey');
  if (typeof batchKey !== 'string') return batchKey;

  const exportedAt = requiredText(source, 'exportedAt');
  if (typeof exportedAt !== 'string') return exportedAt;
  const instant = Date.parse(exportedAt);
  if (Number.isNaN(instant) || instant <= 0) return reject('invalid_exported_at', exportedAt);

  const maxFiles = requiredCount(source, 'maxFiles');
  if (typeof maxFiles !== 'number') return maxFiles;
  if (maxFiles > FEED_MANIFEST_LIMITS.maxFiles) return reject('invalid_file_count', String(maxFiles));

  const maxInputBytes = requiredBudget(source, 'maxInputBytes', FEED_MANIFEST_LIMITS.maxInputBytes);
  if (typeof maxInputBytes !== 'number') return maxInputBytes;
  const maxDecompressedBytes = requiredBudget(source, 'maxDecompressedBytes', FEED_MANIFEST_LIMITS.maxDecompressedBytes);
  if (typeof maxDecompressedBytes !== 'number') return maxDecompressedBytes;

  const delimiter = source['delimiter'] ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1) return reject('invalid_field', 'delimiter');

  const columns = readColumns(source['columns']);
  if ('kind' in columns) return columns;
  const contract = readContract(source['contract']);
  if ('kind' in contract) return contract;

  const files = readFiles(source['files'], maxFiles);
  if ('kind' in files) return files;

  return {
    kind: 'accepted',
    manifest: Object.freeze({
      installationSubject, batchKey, exportedAt, maxFiles, maxInputBytes, maxDecompressedBytes,
      delimiter, columns, contract, files,
    }),
  };
}

function readColumns(value: unknown): TransportColumnMap | FeedManifestDecision {
  if (typeof value !== 'object' || value === null) return reject('invalid_field', 'columns');
  const source = value as Record<string, unknown>;
  const { sourceCode, quantity, unit } = source;
  if (typeof sourceCode !== 'string' || sourceCode.length === 0
    || typeof quantity !== 'string' || quantity.length === 0
    || typeof unit !== 'string' || unit.length === 0) {
    return reject('invalid_field', 'columns');
  }
  return Object.freeze({ sourceCode, quantity, unit });
}

function readContract(value: unknown): InventoryAdapterContract | FeedManifestDecision {
  if (typeof value !== 'object' || value === null) return reject('invalid_field', 'contract');
  const source = value as Record<string, unknown>;
  const { adapterId, revision, sourceCodeNormalization, unitAliases } = source;
  if (typeof adapterId !== 'string' || adapterId.length === 0) return reject('invalid_field', 'contract.adapterId');
  if (!Number.isSafeInteger(revision) || (revision as number) <= 0) return reject('invalid_field', 'contract.revision');
  if (typeof sourceCodeNormalization !== 'string' || !NORMALIZATIONS.includes(sourceCodeNormalization)) {
    return reject('invalid_field', 'contract.sourceCodeNormalization');
  }
  if (typeof unitAliases !== 'object' || unitAliases === null || Array.isArray(unitAliases)) {
    return reject('invalid_field', 'contract.unitAliases');
  }
  const aliases: Record<string, string> = {};
  for (const [token, canonical] of Object.entries(unitAliases as Record<string, unknown>)) {
    if (typeof canonical !== 'string' || canonical.length === 0) return reject('invalid_field', `contract.unitAliases.${token}`);
    aliases[token] = canonical;
  }
  if (Object.keys(aliases).length === 0) return reject('invalid_field', 'contract.unitAliases');
  return Object.freeze({
    adapterId,
    revision: revision as number,
    sourceCodeNormalization: sourceCodeNormalization as SourceCodeNormalization,
    unitAliases: Object.freeze(aliases),
  });
}

function readFiles(value: unknown, maxFiles: number): readonly FeedManifestFile[] | FeedManifestDecision {
  if (!Array.isArray(value)) return reject('invalid_field', 'files');
  if (value.length === 0) return reject('no_files', 'files');
  if (value.length > maxFiles) return reject('too_many_files', `${value.length} declared, ${maxFiles} allowed`);

  const files: FeedManifestFile[] = [];
  const partitionKeys = new Set<string>();
  const relativePaths = new Set<string>();

  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return reject('invalid_field', 'files[]');
    const source = entry as Record<string, unknown>;
    const { relativePath, partitionKey, format, compressed } = source;

    if (typeof relativePath !== 'string' || relativePath.length === 0) return reject('invalid_field', 'files[].relativePath');
    if (typeof partitionKey !== 'string' || partitionKey.length === 0) return reject('invalid_field', 'files[].partitionKey');
    if (typeof compressed !== 'boolean') return reject('invalid_field', 'files[].compressed');
    // The only transport this worker drives is delimited text. Anything a
    // workbook or XML container would need a parser to open is refused here
    // rather than opened and inspected, because nothing in this pass is
    // allowed to interpret a document that can reference or execute.
    if (format !== 'delimited') return reject('unsupported_format', String(format));
    if (resolveContainedPath(PATH_VALIDATION_ROOT, relativePath).kind === 'rejected') {
      return reject('unsafe_relative_path', relativePath);
    }
    if (partitionKeys.has(partitionKey)) return reject('duplicate_partition_key', partitionKey);
    if (relativePaths.has(relativePath)) return reject('duplicate_relative_path', relativePath);
    partitionKeys.add(partitionKey);
    relativePaths.add(relativePath);
    files.push(Object.freeze({ relativePath, partitionKey, format: 'delimited', compressed }));
  }

  return Object.freeze(files);
}

function requiredText(source: Record<string, unknown>, field: string): string | FeedManifestDecision {
  const value = source[field];
  if (value === undefined || value === null || value === '') return reject('missing_field', field);
  if (typeof value !== 'string') return reject('invalid_field', field);
  return value;
}

function requiredCount(source: Record<string, unknown>, field: string): number | FeedManifestDecision {
  const value = source[field];
  if (value === undefined || value === null) return reject('missing_field', field);
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return reject('invalid_file_count', field);
  return value as number;
}

function requiredBudget(source: Record<string, unknown>, field: string, ceiling: number): number | FeedManifestDecision {
  const value = source[field];
  if (value === undefined || value === null) return reject('missing_field', field);
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > ceiling) {
    return reject('invalid_byte_limit', field);
  }
  return value as number;
}

function reject(reason: FeedManifestRejectionReason, detail: string): FeedManifestDecision {
  return { kind: 'rejected', reason, detail };
}
