import type { RawObservation } from './inventory-adapter.ts';

export type TransportRejectionReason =
  | 'invalid_utf8'
  | 'malformed_payload'
  | 'not_a_row_collection'
  | 'missing_column'
  | 'non_string_value'
  | 'ragged_row'
  | 'unsafe_cell'
  | 'too_many_rows'
  | 'no_data_rows';

export type TransportDecision =
  | Readonly<{ kind: 'accepted'; observations: readonly RawObservation[] }>
  | Readonly<{ kind: 'rejected'; reason: TransportRejectionReason; row: number }>;

export type TransportColumnMap = Readonly<{
  sourceCode: string;
  quantity: string;
  unit: string;
}>;

export type TransportLimits = Readonly<{ maxRows: number }>;

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = { maxRows: 250_000 };

export function acceptTransport(observations: readonly RawObservation[]): TransportDecision {
  return { kind: 'accepted', observations: Object.freeze(observations) };
}

export function rejectTransport(reason: TransportRejectionReason, row: number): TransportDecision {
  return { kind: 'rejected', reason, row };
}
