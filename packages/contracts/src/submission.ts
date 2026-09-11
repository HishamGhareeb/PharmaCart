export type { OrderLookup, SubmitResult } from '../generated/contracts.ts';
import type { OrderLookup, SubmitResult } from '../generated/contracts.ts';

export type SubmissionCapabilities = Readonly<{
  authoritativeLookupSupported: boolean;
  retryAfterAuthoritativeNotFound: boolean;
}>;

export type SubmissionFollowUp =
  | Readonly<{ kind: 'acknowledge'; externalOrderId: string }>
  | Readonly<{ kind: 'reject'; code: string }>
  | Readonly<{ kind: 'reconcile'; reconciliationRef: string }>
  | Readonly<{ kind: 'retry_same_reference'; authoritativeAt: string }>
  | Readonly<{ kind: 'human_review'; reconciliationRef: string }>;

export type ContractValidation<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: 'INVALID_CONTRACT_VALUE'; message: string }>;

const invalid = <T>(message: string): ContractValidation<T> => ({
  ok: false,
  code: 'INVALID_CONTRACT_VALUE',
  message,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength * 2
    && [...value].length <= maxLength;
}

export function isUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (match === null) return false;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  return instant.getUTCFullYear() === Number(match[1])
    && instant.getUTCMonth() + 1 === Number(match[2])
    && instant.getUTCDate() === Number(match[3])
    && instant.getUTCHours() === Number(match[4])
    && instant.getUTCMinutes() === Number(match[5])
    && instant.getUTCSeconds() === Number(match[6]);
}

export function validateSubmitResult(input: unknown): ContractValidation<SubmitResult> {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    return invalid('SubmitResult must be a discriminated object');
  }
  if (input.kind === 'accepted'
    && hasExactKeys(input, ['kind', 'externalOrderId'])
    && isBoundedNonEmptyString(input.externalOrderId, 256)) {
    return { ok: true, value: input as SubmitResult };
  }
  if (input.kind === 'rejected'
    && hasExactKeys(input, ['kind', 'code', 'message'])
    && isBoundedNonEmptyString(input.code, 128)
    && isBoundedNonEmptyString(input.message, 1024)) {
    return { ok: true, value: input as SubmitResult };
  }
  if (input.kind === 'unknown'
    && hasExactKeys(input, ['kind', 'reconciliationRef'])
    && isBoundedNonEmptyString(input.reconciliationRef, 256)) {
    return { ok: true, value: input as SubmitResult };
  }
  return invalid('SubmitResult fields do not match its kind');
}

export function validateOrderLookup(input: unknown): ContractValidation<OrderLookup> {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    return invalid('OrderLookup must be a discriminated object');
  }
  if (input.kind === 'found'
    && hasExactKeys(input, ['kind', 'externalOrderId'])
    && isBoundedNonEmptyString(input.externalOrderId, 256)) {
    return { ok: true, value: input as OrderLookup };
  }
  if (input.kind === 'not_found'
    && hasExactKeys(input, ['kind', 'authoritativeAt', 'retryPermitted'])
    && isUtcInstant(input.authoritativeAt)
    && typeof input.retryPermitted === 'boolean') {
    return { ok: true, value: input as OrderLookup };
  }
  if (input.kind === 'inconclusive'
    && hasExactKeys(input, ['kind', 'reconciliationRef'])
    && isBoundedNonEmptyString(input.reconciliationRef, 256)) {
    return { ok: true, value: input as OrderLookup };
  }
  return invalid('OrderLookup fields do not match its kind');
}

export function decideSubmissionFollowUp(
  result: SubmitResult,
  lookup?: OrderLookup,
  capabilities?: SubmissionCapabilities,
): SubmissionFollowUp {
  if (result.kind === 'accepted') {
    return { kind: 'acknowledge', externalOrderId: result.externalOrderId };
  }
  if (result.kind === 'rejected') {
    return { kind: 'reject', code: result.code };
  }
  if (lookup === undefined) {
    return { kind: 'reconcile', reconciliationRef: result.reconciliationRef };
  }
  if (lookup.kind === 'found') {
    return { kind: 'acknowledge', externalOrderId: lookup.externalOrderId };
  }
  if (lookup.kind === 'not_found') {
    const trustedRetryAllowed = lookup.retryPermitted === true
      && capabilities?.authoritativeLookupSupported === true
      && capabilities.retryAfterAuthoritativeNotFound === true;
    return trustedRetryAllowed
      ? { kind: 'retry_same_reference', authoritativeAt: lookup.authoritativeAt }
      : { kind: 'human_review', reconciliationRef: result.reconciliationRef };
  }
  return { kind: 'human_review', reconciliationRef: lookup.reconciliationRef };
}
