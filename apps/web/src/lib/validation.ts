/** Input shapes shared with packages/contracts. Kept as literals so the web app adds no backend imports. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Mirrors the positive canonical decimal pattern used by the quote and receipt command schemas. */
const POSITIVE_DECIMAL = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;

export class InvalidInputError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INVALID_REQUEST') {
    super(message);
    this.name = 'InvalidInputError';
    this.code = code;
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new InvalidInputError(`${label} must be a canonical UUID`);
  return value;
}

export function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 24 && POSITIVE_DECIMAL.test(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
