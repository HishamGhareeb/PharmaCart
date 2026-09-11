export type { ApprovalCommand } from '../generated/contracts.ts';
import type { ApprovalCommand } from '../generated/contracts.ts';

export type ApprovalCommandValidation =
  | Readonly<{ ok: true; value: ApprovalCommand }>
  | Readonly<{ ok: false; code: 'INVALID_APPROVAL_COMMAND'; message: string }>;

const invalid = (message: string): ApprovalCommandValidation => ({
  ok: false,
  code: 'INVALID_APPROVAL_COMMAND',
  message,
});

export function validateApprovalCommand(input: unknown): ApprovalCommandValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('Approval command must be an object');
  }

  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'quoteVersion') {
    return invalid('Approval command must contain only quoteVersion');
  }

  const quoteVersion = (input as Record<string, unknown>).quoteVersion;
  if (typeof quoteVersion !== 'number' || !Number.isSafeInteger(quoteVersion) || quoteVersion <= 0) {
    return invalid('quoteVersion must be a positive safe integer');
  }

  return { ok: true, value: { quoteVersion } };
}
