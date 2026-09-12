import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reapproveDraft } from '../src/draft-reapproval.ts';
import {
  reconcileOfflineDraft,
  type DraftApproval,
  type OfflineDraft,
  type ServerView,
} from '../src/draft-reconciliation.ts';

const approval: DraftApproval = {
  approvedBy: 'user-purchaser-01',
  approvedAt: '2026-09-12T18:00:00Z',
  approvedQuoteVersion: 3,
  approvedTermsVersion: 11,
  approvedTotal: '1450.75',
  idempotencyKey: 'key-original',
};

const draft: OfflineDraft = {
  draftId: 'draft-1',
  installationId: 'inst-branch-01',
  relationshipId: 'rel-supplier-a',
  quoteId: 'quote-9',
  approval,
};

const server: ServerView = {
  membershipStatus: 'active',
  relationshipStatus: 'active',
  termsVersion: 11,
  quote: { quoteId: 'quote-9', version: 3, total: '1450.75', status: 'current' },
};

function approvedBy(who: string, view: ServerView, at = '2026-09-13T08:00:00Z') {
  const result = reapproveDraft(draft, view, who, at);
  assert.equal(result.kind, 'approved', result.kind === 'refused' ? result.reason : '');
  return result.kind === 'approved' ? result : undefined;
}

describe('manual re-approval after reconnecting', () => {
  it('binds the new approval to the state the server reports now', () => {
    const changed: ServerView = {
      ...server,
      termsVersion: 12,
      quote: { quoteId: 'quote-10', version: 5, total: '1502.00', status: 'current' },
    };
    const result = approvedBy('user-purchaser-01', changed);

    assert.equal(result?.approval.approvedTermsVersion, 12);
    assert.equal(result?.approval.approvedQuoteVersion, 5);
    assert.equal(result?.approval.approvedTotal, '1502.00');
    assert.equal(result?.approval.approvedBy, 'user-purchaser-01');
    assert.equal(result?.draft.quoteId, 'quote-10');
  });

  it('issues a different idempotency key once a bound fact has moved', () => {
    const result = approvedBy('user-purchaser-01', { ...server, termsVersion: 12 });
    assert.notEqual(result?.approval.idempotencyKey, approval.idempotencyKey);
  });

  it('derives the same key from the same bound facts, so a retry cannot duplicate an order', () => {
    const first = approvedBy('user-purchaser-01', { ...server, termsVersion: 12 });
    const second = approvedBy('user-purchaser-01', { ...server, termsVersion: 12 }, '2026-09-13T09:30:00Z');

    assert.equal(first?.approval.idempotencyKey, second?.approval.idempotencyKey);
    assert.notEqual(first?.approval.approvedAt, second?.approval.approvedAt);
  });

  it('gives two people approving the same state one key, not two orders', () => {
    const owner = approvedBy('user-owner-01', { ...server, termsVersion: 12 });
    const purchaser = approvedBy('user-purchaser-01', { ...server, termsVersion: 12 });

    assert.equal(owner?.approval.idempotencyKey, purchaser?.approval.idempotencyKey);
    assert.notEqual(owner?.approval.approvedBy, purchaser?.approval.approvedBy);
  });

  it('separates keys across drafts, relationships and totals', () => {
    const base = approvedBy('user-purchaser-01', server)?.approval.idempotencyKey;
    const otherTotal = approvedBy('user-purchaser-01', {
      ...server,
      quote: { ...server.quote!, total: '1450.76' },
    })?.approval.idempotencyKey;

    const otherDraft = reapproveDraft(
      { ...draft, draftId: 'draft-2' },
      server,
      'user-purchaser-01',
      '2026-09-13T08:00:00Z',
    );

    assert.notEqual(base, otherTotal);
    assert.notEqual(base, otherDraft.kind === 'approved' ? otherDraft.approval.idempotencyKey : '');
  });

  it('produces a draft that then reconciles as submittable', () => {
    const changed: ServerView = { ...server, termsVersion: 12 };
    const result = approvedBy('user-purchaser-01', changed);
    const reconciliation = reconcileOfflineDraft(result!.draft, changed);

    assert.equal(reconciliation.kind, 'submittable');
    assert.equal(
      reconciliation.kind === 'submittable' ? reconciliation.idempotencyKey : '',
      result?.approval.idempotencyKey,
    );
  });

  it('refuses to re-approve a draft whose authorisation or quote is gone', () => {
    const refusal = (view: Partial<ServerView>): string => {
      const result = reapproveDraft(draft, { ...server, ...view }, 'user-purchaser-01', '2026-09-13T08:00:00Z');
      assert.equal(result.kind, 'refused');
      return result.kind === 'refused' ? result.reason : '';
    };

    assert.equal(refusal({ membershipStatus: 'revoked' }), 'membership_revoked');
    assert.equal(refusal({ relationshipStatus: 'suspended' }), 'relationship_suspended');
    assert.equal(refusal({ quote: null }), 'quote_missing');
    assert.equal(refusal({ quote: { ...server.quote!, status: 'expired' } }), 'quote_expired');
  });

  it('refuses an approver or timestamp it cannot record', () => {
    const refusal = (who: string, at: string): string => {
      const result = reapproveDraft(draft, server, who, at);
      assert.equal(result.kind, 'refused');
      return result.kind === 'refused' ? result.reason : '';
    };

    assert.equal(refusal('', '2026-09-13T08:00:00Z'), 'invalid_approver');
    assert.equal(refusal('user-purchaser-01', 'not-a-time'), 'invalid_approval_time');
  });
});
