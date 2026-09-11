export const DEFAULT_DECIMAL_MAX_LENGTH = 128;

export type {
  CanonicalDecimalString,
  NonNegativeDecimalString,
  PositiveDecimalString,
} from '../generated/contracts.ts';
import type {
  CanonicalDecimalString,
  NonNegativeDecimalString,
  PositiveDecimalString,
} from '../generated/contracts.ts';

export type DecimalValidationOptions = Readonly<{
  maxLength?: number;
}>;

const CANONICAL_DECIMAL = /^(?:0|0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))(?![\s\S])/;

function resolveMaxLength(options: DecimalValidationOptions): number {
  const maxLength = options.maxLength ?? DEFAULT_DECIMAL_MAX_LENGTH;
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new RangeError('maxLength must be a positive safe integer');
  }
  return maxLength;
}

export function isCanonicalDecimalString(
  value: unknown,
  options: DecimalValidationOptions = {},
): value is CanonicalDecimalString {
  const maxLength = resolveMaxLength(options);
  return typeof value === 'string'
    && value.length <= maxLength
    && CANONICAL_DECIMAL.test(value);
}

export function isNonNegativeDecimalString(
  value: unknown,
  options: DecimalValidationOptions = {},
): value is NonNegativeDecimalString {
  return isCanonicalDecimalString(value, options) && !value.startsWith('-');
}

export function isPositiveDecimalString(
  value: unknown,
  options: DecimalValidationOptions = {},
): value is PositiveDecimalString {
  return isNonNegativeDecimalString(value, options) && value !== '0';
}
