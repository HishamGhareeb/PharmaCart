import type { RawObservation } from './inventory-adapter.ts';
import {
  acceptTransport,
  DEFAULT_TRANSPORT_LIMITS,
  rejectTransport,
  type TransportDecision,
  type TransportLimits,
} from './transport-result.ts';

export function readJsonInventoryPayload(
  payload: unknown,
  limits: Partial<TransportLimits> = {},
): TransportDecision {
  const maxRows = limits.maxRows ?? DEFAULT_TRANSPORT_LIMITS.maxRows;

  if (!Array.isArray(payload)) {
    return rejectTransport('not_a_row_collection', -1);
  }
  if (payload.length === 0) {
    return rejectTransport('no_data_rows', -1);
  }
  if (payload.length > maxRows) {
    return rejectTransport('too_many_rows', -1);
  }

  const observations: RawObservation[] = [];
  for (let row = 0; row < payload.length; row += 1) {
    const entry: unknown = payload[row];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return rejectTransport('malformed_payload', row);
    }

    const record = entry as Readonly<Record<string, unknown>>;
    const sourceCode = record['sourceCode'];
    const quantity = record['quantity'];
    const unit = record['unit'];
    if (typeof sourceCode !== 'string' || typeof quantity !== 'string' || typeof unit !== 'string') {
      return rejectTransport('non_string_value', row);
    }

    observations.push({ sourceCode, quantity, unit });
  }

  return acceptTransport(observations);
}
