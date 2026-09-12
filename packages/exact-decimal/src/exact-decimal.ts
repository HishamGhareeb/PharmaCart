const TRANSPORT_DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
const MAX_DECIMAL_LENGTH = 128;

type ExactDecimal = Readonly<{ mantissa: bigint; scale: number }>;

/**
 * Comparison and multiplication for money and quantities, carried as BigInt
 * mantissas so no value ever passes through a binary float. Returns undefined
 * for an operand it cannot read exactly, because ordering an unreadable price
 * arbitrarily is how the wrong supplier wins.
 */
export function compareDecimals(left: string, right: string): number | undefined {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }

  const scale = Math.max(a.scale, b.scale);
  const scaledLeft = a.mantissa * pow10(scale - a.scale);
  const scaledRight = b.mantissa * pow10(scale - b.scale);
  if (scaledLeft === scaledRight) {
    return 0;
  }
  return scaledLeft < scaledRight ? -1 : 1;
}

export function addDecimals(left: string, right: string): string | undefined {
  return combine(left, right, 1n);
}

export function subtractDecimals(left: string, right: string): string | undefined {
  return combine(left, right, -1n);
}

function combine(left: string, right: string, sign: bigint): string | undefined {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }

  const scale = Math.max(a.scale, b.scale);
  const mantissa = a.mantissa * pow10(scale - a.scale)
    + sign * b.mantissa * pow10(scale - b.scale);
  return formatExactDecimal({ mantissa, scale });
}

export function multiplyDecimals(left: string, right: string): string | undefined {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return formatExactDecimal({ mantissa: a.mantissa * b.mantissa, scale: a.scale + b.scale });
}

function parseExactDecimal(value: string): ExactDecimal | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DECIMAL_LENGTH) {
    return undefined;
  }
  const parsed = TRANSPORT_DECIMAL.exec(value);
  if (parsed === null) {
    return undefined;
  }

  const sign = parsed[1] === '-' ? -1n : 1n;
  const whole = parsed[2] ?? '0';
  const fraction = parsed[3] ?? '';
  return { mantissa: sign * BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function formatExactDecimal(value: ExactDecimal): string {
  const negative = value.mantissa < 0n;
  const digits = (negative ? -value.mantissa : value.mantissa).toString();

  let rendered: string;
  if (value.scale === 0) {
    rendered = digits;
  } else {
    const padded = digits.padStart(value.scale + 1, '0');
    const whole = padded.slice(0, padded.length - value.scale);
    const fraction = padded.slice(padded.length - value.scale).replace(/0+$/, '');
    rendered = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  }

  rendered = rendered.replace(/^0+(?=[0-9])/, '');
  return rendered === '0' || !negative ? rendered : `-${rendered}`;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}
