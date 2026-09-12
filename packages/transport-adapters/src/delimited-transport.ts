import { inspectUntrustedTable } from '../../transport-safety/src/tabular-safety.ts';
import type { RawObservation } from './inventory-adapter.ts';
import {
  acceptTransport,
  DEFAULT_TRANSPORT_LIMITS,
  rejectTransport,
  type TransportColumnMap,
  type TransportDecision,
  type TransportLimits,
} from './transport-result.ts';

export type DelimitedOptions = TransportLimits & Readonly<{ delimiter: string }>;

const BYTE_ORDER_MARK = '\ufeff';

export function readDelimitedInventoryFile(
  columns: TransportColumnMap,
  source: Uint8Array,
  options: Partial<DelimitedOptions> = {},
): TransportDecision {
  const delimiter = options.delimiter ?? ',';
  const maxRows = options.maxRows ?? DEFAULT_TRANSPORT_LIMITS.maxRows;

  if (source.byteLength === 0) {
    return rejectTransport('no_data_rows', -1);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    return rejectTransport('invalid_utf8', -1);
  }
  if (text.startsWith(BYTE_ORDER_MARK)) {
    text = text.slice(1);
  }

  const grid = parseDelimited(text, delimiter);
  if (grid === undefined) {
    return rejectTransport('malformed_payload', -1);
  }

  const header = grid[0];
  const dataRows = grid.slice(1);
  if (header === undefined || dataRows.length === 0) {
    return rejectTransport('no_data_rows', -1);
  }
  if (dataRows.length > maxRows) {
    return rejectTransport('too_many_rows', -1);
  }

  const indices = [columns.sourceCode, columns.quantity, columns.unit]
    .map((column) => header.indexOf(column));
  if (indices.some((index) => index === -1)) {
    return rejectTransport('missing_column', 0);
  }

  for (let row = 0; row < dataRows.length; row += 1) {
    if (dataRows[row]!.length !== header.length) {
      return rejectTransport('ragged_row', row);
    }
  }

  const guard = inspectUntrustedTable(dataRows);
  if (guard.kind === 'rejected') {
    return rejectTransport('unsafe_cell', guard.row);
  }

  const observations: RawObservation[] = dataRows.map((cells) => ({
    sourceCode: cells[indices[0]!]!,
    quantity: cells[indices[1]!]!,
    unit: cells[indices[2]!]!,
  }));

  return acceptTransport(observations);
}

function parseDelimited(text: string, delimiter: string): string[][] | undefined {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let cursor = 0;

  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };

  while (cursor < text.length) {
    const character = text[cursor]!;

    if (quoted) {
      if (character === '"') {
        if (text[cursor + 1] === '"') {
          field += '"';
          cursor += 2;
          continue;
        }
        quoted = false;
        cursor += 1;
        continue;
      }
      field += character;
      cursor += 1;
      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        return undefined;
      }
      quoted = true;
      cursor += 1;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = '';
      cursor += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      cursor += character === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
      endRow();
      continue;
    }

    field += character;
    cursor += 1;
  }

  if (quoted) {
    return undefined;
  }
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}
