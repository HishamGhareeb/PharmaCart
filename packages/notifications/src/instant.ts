/**
 * `Date` parses far more than an instant: a bare year, a locale date, an empty-ish string. Every
 * instant crossing a boundary in this package is required to be unambiguous first, so a malformed
 * value is refused rather than silently becoming an epoch, a NaN comparison, or "now".
 */
const strictInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch, or null when the value is not an unambiguous instant. */
export function strictInstantMs(value: string): number | null {
  if (typeof value !== 'string' || value.length > 40 || !strictInstantPattern.test(value)) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function isStrictInstant(value: string): boolean {
  return strictInstantMs(value) !== null;
}
