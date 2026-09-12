import type { InventoryRow, InventorySnapshotEvent } from '../../domain/src/inventory-snapshot.ts';
import { inspectIdentifierText } from '../../text-identity/src/bidi-safety.ts';
import { inspectUntrustedCell } from '../../transport-safety/src/tabular-safety.ts';
import { canonicaliseDecimal } from './canonical-decimal.ts';

export type RawObservation = Readonly<{ sourceCode: string; quantity: string; unit: string }>;

export type SourceCodeNormalization = 'exact' | 'trim' | 'trim_upper';

export type InventoryAdapterContract = Readonly<{
  adapterId: string;
  revision: number;
  sourceCodeNormalization: SourceCodeNormalization;
  unitAliases: Readonly<Record<string, string>>;
}>;

export type InventoryEnvelope = Readonly<{
  eventId: string;
  installationId: string;
  snapshotId: string;
  sequence: number;
  partitionId: string;
}>;

export type AdapterRejectionReason =
  | 'unsafe_field'
  | 'unsafe_identifier'
  | 'empty_source_code'
  | 'invalid_quantity'
  | 'unknown_unit'
  | 'duplicate_source_code'
  | 'empty_observation_set';

export type InventoryAdapterDecision =
  | Readonly<{ kind: 'accepted'; event: InventorySnapshotEvent }>
  | Readonly<{ kind: 'rejected'; reason: AdapterRejectionReason; sourceCode: string }>;

export function adaptInventoryObservations(
  contract: InventoryAdapterContract,
  envelope: InventoryEnvelope,
  observations: readonly RawObservation[],
): InventoryAdapterDecision {
  if (observations.length === 0) {
    return { kind: 'rejected', reason: 'empty_observation_set', sourceCode: '' };
  }

  const units = canonicalUnits(contract.unitAliases);
  const rows: InventoryRow[] = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    for (const field of [observation.sourceCode, observation.quantity, observation.unit]) {
      if (inspectUntrustedCell(field).kind === 'rejected') {
        return { kind: 'rejected', reason: 'unsafe_field', sourceCode: observation.sourceCode };
      }
    }

    const sourceCode = normaliseSourceCode(observation.sourceCode, contract.sourceCodeNormalization);
    if (sourceCode.length === 0) {
      return { kind: 'rejected', reason: 'empty_source_code', sourceCode: observation.sourceCode };
    }
    if (inspectIdentifierText(sourceCode).kind === 'rejected') {
      return { kind: 'rejected', reason: 'unsafe_identifier', sourceCode };
    }

    const quantity = canonicaliseDecimal(observation.quantity);
    if (quantity === undefined || quantity.startsWith('-')) {
      return { kind: 'rejected', reason: 'invalid_quantity', sourceCode };
    }

    const unit = units.get(observation.unit.trim().toLowerCase());
    if (unit === undefined) {
      return { kind: 'rejected', reason: 'unknown_unit', sourceCode };
    }

    if (seen.has(sourceCode)) {
      return { kind: 'rejected', reason: 'duplicate_source_code', sourceCode };
    }
    seen.add(sourceCode);
    rows.push({ sourceCode, quantity, unit });
  }

  rows.sort((left, right) => compareSourceCodes(left.sourceCode, right.sourceCode));

  return {
    kind: 'accepted',
    event: {
      kind: 'partition',
      eventId: envelope.eventId,
      installationId: envelope.installationId,
      snapshotId: envelope.snapshotId,
      sequence: envelope.sequence,
      partitionId: envelope.partitionId,
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    },
  };
}

function canonicalUnits(aliases: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const units = new Map<string, string>();
  for (const [token, canonical] of Object.entries(aliases)) {
    units.set(token.trim().toLowerCase(), canonical);
  }
  return units;
}

function normaliseSourceCode(raw: string, normalization: SourceCodeNormalization): string {
  if (normalization === 'exact') {
    return raw;
  }
  const trimmed = raw.trim();
  return normalization === 'trim_upper' ? trimmed.toUpperCase() : trimmed;
}

function compareSourceCodes(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
