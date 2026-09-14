import type { InventoryRow, InventorySnapshotEvent } from '../../domain/src/inventory-snapshot.ts';
import {
  adaptInventoryObservations,
  type InventoryAdapterContract,
  type InventoryEnvelope,
  type RawObservation,
} from '../../transport-adapters/src/inventory-adapter.ts';
import { readDelimitedInventoryFile } from '../../transport-adapters/src/delimited-transport.ts';
import type { TransportColumnMap } from '../../transport-adapters/src/transport-result.ts';
import { gunzipWithinBudget } from '../../transport-safety/src/decompression-budget.ts';
import {
  resolveContainedPath,
  type ContainedFileReader,
} from '../../transport-safety/src/path-boundary.ts';

/**
 * The order is the security property, not an implementation detail. A path is
 * bounded before anything opens it, a compressed payload is capped before it is
 * inflated, cells are guarded before they are read as meaning, and meaning is
 * settled before the domain sees an event. Passing the reader in rather than
 * calling the filesystem is what makes that order enforceable instead of
 * merely documented.
 */
export const INGESTION_STAGES = ['path', 'read', 'decompression', 'parse', 'adapt'] as const;

export type IngestionStage = (typeof INGESTION_STAGES)[number];

export type FeedIngestionRequest = Readonly<{
  root: string;
  relativePath: string;
  compressed: boolean;
  columns: TransportColumnMap;
  contract: InventoryAdapterContract;
  envelope: InventoryEnvelope;
  maxInputBytes: number;
  maxDecompressedBytes?: number;
  delimiter?: string;
}>;

/** The same request without an envelope, for a caller that cannot know the
 *  envelope yet because deriving it needs the rows this call produces. */
export type FeedRowsRequest = Omit<FeedIngestionRequest, 'envelope'>;

export type FeedRejection = Readonly<{
  kind: 'rejected';
  stage: IngestionStage;
  reason: string;
  detail: string;
}>;

export type FeedIngestionResult =
  | Readonly<{
      kind: 'accepted';
      absolutePath: string;
      event: InventorySnapshotEvent;
      observationCount: number;
    }>
  | FeedRejection;

export type FeedRowsResult =
  | Readonly<{
      kind: 'accepted';
      absolutePath: string;
      rows: readonly InventoryRow[];
      observationCount: number;
    }>
  | FeedRejection;

export async function ingestDelimitedFeed(
  request: FeedIngestionRequest,
  reader: ContainedFileReader,
): Promise<FeedIngestionResult> {
  const observed = await readGuardedObservations(request, reader);
  if (observed.kind === 'rejected') {
    return observed;
  }

  const adapted = adaptInventoryObservations(request.contract, request.envelope, observed.observations);
  if (adapted.kind === 'rejected') {
    return reject('adapt', adapted.reason, adapted.sourceCode);
  }

  return {
    kind: 'accepted',
    absolutePath: observed.absolutePath,
    event: adapted.event,
    observationCount: observed.observations.length,
  };
}

/**
 * Replay-safe identity is a function of the canonical rows, so the rows have to
 * exist before the envelope does. This runs the identical five guards in the
 * identical order and stops one step short, handing back the adapted rows rather
 * than an event. The caller derives the envelope from them — inside the
 * transaction that reads the accepted-sequence watermark — and only then has a
 * domain event.
 */
export async function readDelimitedFeedRows(
  request: FeedRowsRequest,
  reader: ContainedFileReader,
): Promise<FeedRowsResult> {
  const observed = await readGuardedObservations(request, reader);
  if (observed.kind === 'rejected') {
    return observed;
  }

  // The adapter is the only thing that knows how to turn an observation into a
  // canonical row, and its guards (formula payloads, deceptive identifiers,
  // signed or unreadable quantities, undeclared units, duplicate codes) are the
  // reason to go through it rather than around it. Only the rows are kept; the
  // placeholder identity never leaves this function and is never persisted.
  const adapted = adaptInventoryObservations(request.contract, ROWS_ONLY_ENVELOPE, observed.observations);
  if (adapted.kind === 'rejected') {
    return reject('adapt', adapted.reason, adapted.sourceCode);
  }

  return {
    kind: 'accepted',
    absolutePath: observed.absolutePath,
    rows: adapted.event.kind === 'partition' ? adapted.event.rows : [],
    observationCount: observed.observations.length,
  };
}

const ROWS_ONLY_ENVELOPE: InventoryEnvelope = Object.freeze({
  eventId: 'rows-only',
  installationId: 'rows-only',
  snapshotId: 'rows-only',
  sequence: 1,
  partitionId: 'rows-only',
});

type GuardedObservations =
  | Readonly<{ kind: 'accepted'; absolutePath: string; observations: readonly RawObservation[] }>
  | FeedRejection;

async function readGuardedObservations(
  request: FeedRowsRequest,
  reader: ContainedFileReader,
): Promise<GuardedObservations> {
  const located = resolveContainedPath(request.root, request.relativePath);
  if (located.kind === 'rejected') {
    return reject('path', located.reason, located.segment);
  }

  if (!Number.isSafeInteger(request.maxInputBytes) || request.maxInputBytes <= 0) {
    return reject('read', 'invalid_byte_limit', request.relativePath);
  }

  let read: Awaited<ReturnType<ContainedFileReader['readContained']>>;
  try {
    read = await reader.readContained({
      root: request.root,
      relativePath: located.relativePath,
      maxBytes: request.maxInputBytes,
    });
  } catch {
    return reject('read', 'read_failed', request.relativePath);
  }
  if (read.kind === 'rejected') {
    return reject('read', read.reason, read.detail);
  }
  if (read.data.byteLength > request.maxInputBytes) {
    return reject('read', 'input_too_large', read.absolutePath);
  }
  let payload = read.data;

  if (request.compressed) {
    const inflated = gunzipWithinBudget(
      payload,
      request.maxDecompressedBytes === undefined
        ? {}
        : { maxOutputBytes: request.maxDecompressedBytes },
    );
    if (inflated.kind === 'rejected') {
      return reject('decompression', inflated.reason, read.absolutePath);
    }
    payload = inflated.data;
  }

  const parsed = readDelimitedInventoryFile(
    request.columns,
    payload,
    request.delimiter === undefined ? {} : { delimiter: request.delimiter },
  );
  if (parsed.kind === 'rejected') {
    return reject('parse', parsed.reason, `row ${parsed.row}`);
  }

  return { kind: 'accepted', absolutePath: read.absolutePath, observations: parsed.observations };
}

function reject(stage: IngestionStage, reason: string, detail: string): FeedRejection {
  return { kind: 'rejected', stage, reason, detail };
}
