import type { InventorySnapshotEvent } from '../../domain/src/inventory-snapshot.ts';
import {
  adaptInventoryObservations,
  type InventoryAdapterContract,
  type InventoryEnvelope,
} from '../../transport-adapters/src/inventory-adapter.ts';
import { readDelimitedInventoryFile } from '../../transport-adapters/src/delimited-transport.ts';
import type { TransportColumnMap } from '../../transport-adapters/src/transport-result.ts';
import { gunzipWithinBudget } from '../../transport-safety/src/decompression-budget.ts';
import { resolveContainedPath } from '../../transport-safety/src/path-boundary.ts';

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

export type FeedReader = (absolutePath: string) => Promise<Uint8Array>;

export type FeedIngestionRequest = Readonly<{
  root: string;
  relativePath: string;
  compressed: boolean;
  columns: TransportColumnMap;
  contract: InventoryAdapterContract;
  envelope: InventoryEnvelope;
  maxDecompressedBytes?: number;
  delimiter?: string;
}>;

export type FeedIngestionResult =
  | Readonly<{
      kind: 'accepted';
      absolutePath: string;
      event: InventorySnapshotEvent;
      observationCount: number;
    }>
  | Readonly<{ kind: 'rejected'; stage: IngestionStage; reason: string; detail: string }>;

export async function ingestDelimitedFeed(
  request: FeedIngestionRequest,
  read: FeedReader,
): Promise<FeedIngestionResult> {
  const located = resolveContainedPath(request.root, request.relativePath);
  if (located.kind === 'rejected') {
    return reject('path', located.reason, located.segment);
  }

  let payload: Uint8Array;
  try {
    payload = await read(located.absolutePath);
  } catch {
    return reject('read', 'read_failed', located.absolutePath);
  }

  if (request.compressed) {
    const inflated = gunzipWithinBudget(
      payload,
      request.maxDecompressedBytes === undefined
        ? {}
        : { maxOutputBytes: request.maxDecompressedBytes },
    );
    if (inflated.kind === 'rejected') {
      return reject('decompression', inflated.reason, located.absolutePath);
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

  const adapted = adaptInventoryObservations(
    request.contract,
    request.envelope,
    parsed.observations,
  );
  if (adapted.kind === 'rejected') {
    return reject('adapt', adapted.reason, adapted.sourceCode);
  }

  return {
    kind: 'accepted',
    absolutePath: located.absolutePath,
    event: adapted.event,
    observationCount: parsed.observations.length,
  };
}

function reject(stage: IngestionStage, reason: string, detail: string): FeedIngestionResult {
  return { kind: 'rejected', stage, reason, detail };
}
