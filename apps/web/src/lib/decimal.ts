/**
 * Minimal exact decimal arithmetic for display and bounds.
 *
 * Quantities travel as canonical decimal strings end to end. The browser never converts them to
 * binary floating point, so a remaining quantity shown here is exactly what the API reported.
 */

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function scaled(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

export function canonicalDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

const TYPED_QUANTITY = /^[0-9]+(?:\.[0-9]+)?$/;

/**
 * Normalises a quantity an operator typed into the canonical decimal the API's schemas require.
 *
 * `packages/contracts` refuses a trailing fraction zero, but `1.50` and `2.0` are ordinary things for
 * a person to type and for a number input to produce. Rewriting them changes no value, so it is done
 * here rather than letting the operator collide with a schema refusal that names a canonical decimal
 * the form never mentioned. Anything that is not a plain non-negative decimal returns null; a
 * negative, an exponent or a stray character is a mistake to report, not one to rewrite.
 */
export function canonicalQuantity(value: string): string | null {
  const trimmed = value.trim();
  if (!TYPED_QUANTITY.test(trimmed)) return null;
  const [whole = '', fraction] = trimmed.split('.');
  const leading = whole.replace(/^0+(?=[0-9])/, '');
  return canonicalDecimal(fraction === undefined ? leading : `${leading}.${fraction}`);
}

/** Returns a - b, or null when either side is not a plain decimal. Never returns a negative value. */
export function remainingQuantity(shipped: string, received: string): string | null {
  if (!DECIMAL.test(shipped) || !DECIMAL.test(received)) return null;
  const scale = Math.max(shipped.split('.')[1]?.length ?? 0, received.split('.')[1]?.length ?? 0);
  const difference = scaled(shipped, scale) - scaled(received, scale);
  if (difference <= 0n) return '0';
  const digits = difference.toString().padStart(scale + 1, '0');
  const result = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return canonicalDecimal(result);
}
