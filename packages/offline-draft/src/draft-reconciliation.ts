export type DraftApproval = Readonly<{
  approvedBy: string;
  approvedAt: string;
  approvedQuoteVersion: number;
  approvedTermsVersion: number;
  approvedTotal: string;
  idempotencyKey: string;
}>;

export type OfflineDraft = Readonly<{
  draftId: string;
  installationId: string;
  relationshipId: string;
  quoteId: string;
  approval: DraftApproval | null;
}>;

export type ServerQuote = Readonly<{
  quoteId: string;
  version: number;
  total: string;
  status: 'current' | 'superseded' | 'expired';
}>;

export type ServerView = Readonly<{
  membershipStatus: 'active' | 'revoked';
  relationshipStatus: 'active' | 'suspended' | 'revoked';
  termsVersion: number;
  quote: ServerQuote | null;
}>;

export type BlockReason =
  | 'membership_revoked'
  | 'relationship_revoked'
  | 'relationship_suspended'
  | 'quote_missing'
  | 'quote_expired';

export type ReapprovalReason =
  | 'never_approved'
  | 'terms_changed'
  | 'quote_replaced'
  | 'quote_superseded'
  | 'total_changed';

export type DraftReconciliation =
  | Readonly<{ kind: 'submittable'; idempotencyKey: string }>
  | Readonly<{ kind: 'requires_approval'; reasons: readonly ReapprovalReason[] }>
  | Readonly<{ kind: 'blocked'; reason: BlockReason }>;

export type SubmissionRelease =
  | Readonly<{ kind: 'released'; idempotencyKey: string }>
  | Readonly<{ kind: 'refused'; reason: 'approval_required' | 'blocked' }>;

export function reconcileOfflineDraft(draft: OfflineDraft, server: ServerView): DraftReconciliation {
  const blocked = authorisationBlock(server);
  if (blocked !== undefined) {
    return { kind: 'blocked', reason: blocked };
  }

  const quote = server.quote;
  if (quote === null) {
    return { kind: 'blocked', reason: 'quote_missing' };
  }
  if (quote.status === 'expired') {
    return { kind: 'blocked', reason: 'quote_expired' };
  }

  const approval = draft.approval;
  if (approval === null) {
    return { kind: 'requires_approval', reasons: Object.freeze(['never_approved' as const]) };
  }

  const reasons: ReapprovalReason[] = [];
  if (approval.approvedTermsVersion !== server.termsVersion) {
    reasons.push('terms_changed');
  }
  if (draft.quoteId !== quote.quoteId) {
    reasons.push('quote_replaced');
  }
  if (approval.approvedQuoteVersion !== quote.version || quote.status === 'superseded') {
    reasons.push('quote_superseded');
  }
  if (approval.approvedTotal !== quote.total) {
    reasons.push('total_changed');
  }

  return reasons.length === 0
    ? { kind: 'submittable', idempotencyKey: approval.idempotencyKey }
    : { kind: 'requires_approval', reasons: Object.freeze(reasons) };
}

export function releaseForSubmission(reconciliation: DraftReconciliation): SubmissionRelease {
  if (reconciliation.kind === 'submittable') {
    return { kind: 'released', idempotencyKey: reconciliation.idempotencyKey };
  }
  return {
    kind: 'refused',
    reason: reconciliation.kind === 'blocked' ? 'blocked' : 'approval_required',
  };
}

function authorisationBlock(server: ServerView): BlockReason | undefined {
  if (server.membershipStatus === 'revoked') {
    return 'membership_revoked';
  }
  if (server.relationshipStatus === 'revoked') {
    return 'relationship_revoked';
  }
  if (server.relationshipStatus === 'suspended') {
    return 'relationship_suspended';
  }
  return undefined;
}
