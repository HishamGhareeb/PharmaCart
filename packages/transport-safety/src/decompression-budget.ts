import zlib from 'node:zlib';

export type DecompressionRejectionReason =
  | 'input_too_large'
  | 'output_too_large'
  | 'ratio_exceeded'
  | 'invalid_archive';

export type DecompressionLimits = Readonly<{
  maxInputBytes: number;
  maxOutputBytes: number;
  maxRatio: number;
}>;

export type DecompressionDecision =
  | Readonly<{ kind: 'accepted'; data: Uint8Array; ratio: number }>
  | Readonly<{ kind: 'rejected'; reason: DecompressionRejectionReason }>;

export const DEFAULT_DECOMPRESSION_LIMITS: DecompressionLimits = {
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxRatio: 200,
};

export function gunzipWithinBudget(
  source: Uint8Array,
  limits: Partial<DecompressionLimits> = {},
): DecompressionDecision {
  const maxInputBytes = limits.maxInputBytes ?? DEFAULT_DECOMPRESSION_LIMITS.maxInputBytes;
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_DECOMPRESSION_LIMITS.maxOutputBytes;
  const maxRatio = limits.maxRatio ?? DEFAULT_DECOMPRESSION_LIMITS.maxRatio;

  if (source.byteLength > maxInputBytes) {
    return { kind: 'rejected', reason: 'input_too_large' };
  }

  let expanded: Buffer;
  try {
    expanded = zlib.gunzipSync(source, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    return {
      kind: 'rejected',
      reason: isOutputOverflow(error) ? 'output_too_large' : 'invalid_archive',
    };
  }

  if (expanded.byteLength > maxOutputBytes) {
    return { kind: 'rejected', reason: 'output_too_large' };
  }

  const ratio = source.byteLength === 0 ? Infinity : expanded.byteLength / source.byteLength;
  if (ratio > maxRatio) {
    return { kind: 'rejected', reason: 'ratio_exceeded' };
  }

  return { kind: 'accepted', data: new Uint8Array(expanded), ratio };
}

function isOutputOverflow(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as Readonly<{ code: unknown }>).code === 'ERR_BUFFER_TOO_LARGE';
}
