import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  reconcileOfflineDraft,
  releaseForSubmission,
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

function reasonsFor(overrides: Partial<ServerView>): readonly string[] {
  const result = reconcileOfflineDraft(draft, { ...server, ...overrides });
  assert.equal(result.kind, 'requires_approval', result.kind);
  return result.kind === 'requires_approval' ? result.reasons : [];
}

function blockedBy(overrides: Partial<ServerView>): string {
  const result = reconcileOfflineDraft(draft, { ...server, ...overrides });
  assert.equal(result.kind, 'blocked', result.kind);
  return result.kind === 'blocked' ? result.reason : '';
}

describe('AC-012 offline draft reconnecting after a terms change', () => {
  it('requires manual approval and exposes no way to submit', () => {
    const result = reconcileOfflineDraft(draft, { ...server, termsVersion: 12 });

    assert.equal(result.kind, 'requires_approval');
    assert.deepEqual(result.kind === 'requires_approval' ? result.reasons : [], ['terms_changed']);
    assert.equal(Object.hasOwn(result, 'idempotencyKey'), false);

    const release = releaseForSubmission(result);
    assert.equal(release.kind, 'refused');
    assert.equal(release.kind === 'refused' ? release.reason : '', 'approval_required');
  });
});

describe('offline draft reconciliation', () => {
  it('releases an unchanged approved draft with its original idempotency key', () => {
    const result = reconcileOfflineDraft(draft, server);
    assert.equal(result.kind, 'submittable');

    const release = releaseForSubmission(result);
    assert.equal(release.kind === 'released' ? release.idempotencyKey : '', 'key-original');
  });

  it('requires approval for a draft that was never approved', () => {
    const result = reconcileOfflineDraft({ ...draft, approval: null }, server);
    assert.deepEqual(result.kind === 'requires_approval' ? result.reasons : [], ['never_approved']);
  });

  it('names each bound fact that moved while the device was offline', () => {
    assert.deepEqual(reasonsFor({ termsVersion: 12 }), ['terms_changed']);
    assert.deepEqual(
      reasonsFor({ quote: { ...server.quote!, version: 4 } }),
      ['quote_superseded'],
    );
    assert.deepEqual(
      reasonsFor({ quote: { ...server.quote!, total: '1501.00' } }),
      ['total_changed'],
    );
    assert.deepEqual(
      reasonsFor({ quote: { ...server.quote!, quoteId: 'quote-10' } }),
      ['quote_replaced'],
    );
  });

  it('reports every reason at once rather than the first one found', () => {
    assert.deepEqual(
      reasonsFor({ termsVersion: 12, quote: { ...server.quote!, version: 4, total: '1600.00' } }),
      ['terms_changed', 'quote_superseded', 'total_changed'],
    );
  });

  it('blocks a draft whose authorisation no longer holds', () => {
    assert.equal(blockedBy({ membershipStatus: 'revoked' }), 'membership_revoked');
    assert.equal(blockedBy({ relationshipStatus: 'revoked' }), 'relationship_revoked');
    assert.equal(blockedBy({ relationshipStatus: 'suspended' }), 'relationship_suspended');
  });

  it('blocks a draft whose quote can no longer be honoured', () => {
    assert.equal(blockedBy({ quote: { ...server.quote!, status: 'expired' } }), 'quote_expired');
    assert.equal(blockedBy({ quote: null }), 'quote_missing');
  });

  it('puts authorisation ahead of approval so a revoked user is never merely reprompted', () => {
    const result = reconcileOfflineDraft(draft, {
      ...server,
      membershipStatus: 'revoked',
      termsVersion: 12,
    });
    assert.equal(result.kind, 'blocked');
  });

  it('refuses to release anything that is not submittable', () => {
    const blocked = reconcileOfflineDraft(draft, { ...server, membershipStatus: 'revoked' });
    const release = releaseForSubmission(blocked);
    assert.equal(release.kind, 'refused');
    assert.equal(release.kind === 'refused' ? release.reason : '', 'blocked');
  });
});
