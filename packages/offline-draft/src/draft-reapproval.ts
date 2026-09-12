import { createHash } from 'node:crypto';

import type {
  BlockReason,
  DraftApproval,
  OfflineDraft,
  ServerQuote,
  ServerView,
} from './draft-reconciliation.ts';

export type ReapprovalRefusalReason = BlockReason | 'invalid_approver' | 'invalid_approval_time';

export type ReapprovalResult =
  | Readonly<{ kind: 'approved'; draft: OfflineDraft; approval: DraftApproval }>
  | Readonly<{ kind: 'refused'; reason: ReapprovalRefusalReason }>;

const IDEMPOTENCY_KEY_LENGTH = 32;

export function reapproveDraft(
  draft: OfflineDraft,
  server: ServerView,
  approvedBy: string,
  approvedAt: string,
): ReapprovalResult {
  if (server.membershipStatus === 'revoked') {
    return { kind: 'refused', reason: 'membership_revoked' };
  }
  if (server.relationshipStatus === 'revoked') {
    return { kind: 'refused', reason: 'relationship_revoked' };
  }
  if (server.relationshipStatus === 'suspended') {
    return { kind: 'refused', reason: 'relationship_suspended' };
  }

  const quote = server.quote;
  if (quote === null) {
    return { kind: 'refused', reason: 'quote_missing' };
  }
  if (quote.status === 'expired') {
    return { kind: 'refused', reason: 'quote_expired' };
  }

  if (approvedBy.length === 0 || approvedBy.length > 256) {
    return { kind: 'refused', reason: 'invalid_approver' };
  }
  if (Number.isNaN(new Date(approvedAt).getTime())) {
    return { kind: 'refused', reason: 'invalid_approval_time' };
  }

  const approval: DraftApproval = Object.freeze({
    approvedBy,
    approvedAt,
    approvedQuoteVersion: quote.version,
    approvedTermsVersion: server.termsVersion,
    approvedTotal: quote.total,
    idempotencyKey: deriveIdempotencyKey(draft, server, quote),
  });

  return {
    kind: 'approved',
    draft: Object.freeze({ ...draft, quoteId: quote.quoteId, approval }),
    approval,
  };
}

/**
 * Derived from the facts the approval binds, never from who approved or when.
 * Two clients approving identical state therefore present one key and the
 * server collapses them into a single intent, while any change to a bound
 * fact yields a new key instead of a conflict against the previous body.
 */
function deriveIdempotencyKey(
  draft: OfflineDraft,
  server: ServerView,
  quote: ServerQuote,
): string {
  const boundFacts = JSON.stringify([
    draft.draftId,
    draft.installationId,
    draft.relationshipId,
    quote.quoteId,
    quote.version,
    quote.total,
    server.termsVersion,
  ]);
  return createHash('sha256').update(boundFacts).digest('hex').slice(0, IDEMPOTENCY_KEY_LENGTH);
}
