export type TabularRejectionReason =
  | 'formula_prefix'
  | 'control_character'
  | 'cell_too_long'
  | 'too_many_rows'
  | 'too_many_columns';

export type TabularSafetyLimits = Readonly<{
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
}>;

export type CellSafetyDecision =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'rejected'; reason: TabularRejectionReason }>;

export type TabularSafetyDecision =
  | Readonly<{ kind: 'accepted'; rowCount: number; columnCount: number }>
  | Readonly<{ kind: 'rejected'; reason: TabularRejectionReason; row: number; column: number }>;

export const DEFAULT_TABULAR_SAFETY_LIMITS: TabularSafetyLimits = {
  maxRows: 250_000,
  maxColumns: 512,
  maxCellLength: 32_768,
};

const FORMULA_PREFIXES: ReadonlySet<string> = new Set(['=', '+', '-', '@']);
const PLAIN_NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
const IGNORABLE_LEAD = /^[\s\u200b-\u200d\ufeff]+/;

export function inspectUntrustedCell(value: string, maxCellLength?: number): CellSafetyDecision {
  const lengthBudget = maxCellLength ?? DEFAULT_TABULAR_SAFETY_LIMITS.maxCellLength;
  if (value.length > lengthBudget) {
    return { kind: 'rejected', reason: 'cell_too_long' };
  }

  const effective = value.replace(IGNORABLE_LEAD, '');
  const lead = effective.slice(0, 1);
  if (FORMULA_PREFIXES.has(lead) && !PLAIN_NUMBER.test(effective)) {
    return { kind: 'rejected', reason: 'formula_prefix' };
  }

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return { kind: 'rejected', reason: 'control_character' };
    }
  }

  return { kind: 'accepted' };
}

export function inspectUntrustedTable(
  rows: readonly (readonly string[])[],
  limits: Partial<TabularSafetyLimits> = {},
): TabularSafetyDecision {
  const maxRows = limits.maxRows ?? DEFAULT_TABULAR_SAFETY_LIMITS.maxRows;
  const maxColumns = limits.maxColumns ?? DEFAULT_TABULAR_SAFETY_LIMITS.maxColumns;
  const maxCellLength = limits.maxCellLength ?? DEFAULT_TABULAR_SAFETY_LIMITS.maxCellLength;

  if (rows.length > maxRows) {
    return { kind: 'rejected', reason: 'too_many_rows', row: -1, column: -1 };
  }

  let columnCount = 0;
  for (let row = 0; row < rows.length; row += 1) {
    const cells = rows[row] ?? [];
    if (cells.length > maxColumns) {
      return { kind: 'rejected', reason: 'too_many_columns', row, column: -1 };
    }
    columnCount = Math.max(columnCount, cells.length);

    for (let column = 0; column < cells.length; column += 1) {
      const decision = inspectUntrustedCell(cells[column] ?? '', maxCellLength);
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', reason: decision.reason, row, column };
      }
    }
  }

  return { kind: 'accepted', rowCount: rows.length, columnCount };
}
