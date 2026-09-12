import { DEFAULT_DECIMAL_MAX_LENGTH, isCanonicalDecimalString } from '../../contracts/src/decimal.ts';

const TRANSPORT_DECIMAL = /^(-?)([0-9]*)(?:\.([0-9]*))?$/;

export function canonicaliseDecimal(raw: string, maxLength: number = DEFAULT_DECIMAL_MAX_LENGTH): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) {
    return undefined;
  }

  const parsed = TRANSPORT_DECIMAL.exec(raw);
  if (parsed === null) {
    return undefined;
  }

  const sign = parsed[1] ?? '';
  const whole = parsed[2] ?? '';
  const fraction = parsed[3] ?? '';
  if (whole.length === 0 && fraction.length === 0) {
    return undefined;
  }

  const trimmedWhole = whole.replace(/^0+/, '');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const magnitude = trimmedFraction.length === 0
    ? (trimmedWhole.length === 0 ? '0' : trimmedWhole)
    : `${trimmedWhole.length === 0 ? '0' : trimmedWhole}.${trimmedFraction}`;

  const canonical = magnitude === '0' ? '0' : `${sign}${magnitude}`;
  return isCanonicalDecimalString(canonical, { maxLength }) ? canonical : undefined;
}
