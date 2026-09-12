import type { RawObservation } from './inventory-adapter.ts';
import {
  acceptTransport,
  DEFAULT_TRANSPORT_LIMITS,
  rejectTransport,
  type TransportColumnMap,
  type TransportDecision,
  type TransportLimits,
} from './transport-result.ts';

export function readDatabaseViewRows(
  columns: TransportColumnMap,
  rows: readonly Readonly<Record<string, unknown>>[],
  limits: Partial<TransportLimits> = {},
): TransportDecision {
  const maxRows = limits.maxRows ?? DEFAULT_TRANSPORT_LIMITS.maxRows;

  if (!Array.isArray(rows)) {
    return rejectTransport('not_a_row_collection', -1);
  }
  if (rows.length === 0) {
    return rejectTransport('no_data_rows', -1);
  }
  if (rows.length > maxRows) {
    return rejectTransport('too_many_rows', -1);
  }

  const observations: RawObservation[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const record = rows[row] ?? {};
    const fields: string[] = [];

    for (const column of [columns.sourceCode, columns.quantity, columns.unit]) {
      if (!Object.hasOwn(record, column)) {
        return rejectTransport('missing_column', row);
      }
      const value = coerceColumnValue(record[column]);
      if (value === undefined) {
        return rejectTransport('non_string_value', row);
      }
      fields.push(value);
    }

    observations.push({ sourceCode: fields[0]!, quantity: fields[1]!, unit: fields[2]! });
  }

  return acceptTransport(observations);
}

function coerceColumnValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}
