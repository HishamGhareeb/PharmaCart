import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  decideSubmissionFollowUp,
  validateOrderLookup,
  validateSubmitResult,
} from '../src/submission.ts';
import type { OrderLookup, SubmissionCapabilities, SubmitResult } from '../src/submission.ts';

const retryCapability: SubmissionCapabilities = {
  authoritativeLookupSupported: true,
  retryAfterAuthoritativeNotFound: true,
};

describe('submission follow-up decision', () => {
  test('records accepted and rejected submission outcomes as terminal evidence', () => {
    const accepted: SubmitResult = { kind: 'accepted', externalOrderId: 'ERP-001' };
    const rejected: SubmitResult = { kind: 'rejected', code: 'ACCOUNT_BLOCKED', message: 'Account blocked' };

    assert.deepEqual(decideSubmissionFollowUp(accepted), { kind: 'acknowledge', externalOrderId: 'ERP-001' });
    assert.deepEqual(decideSubmissionFollowUp(rejected), { kind: 'reject', code: 'ACCOUNT_BLOCKED' });
  });

  test('an unknown submission without lookup evidence is never retried', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-1' };

    assert.deepEqual(decideSubmissionFollowUp(unknown), {
      kind: 'reconcile',
      reconciliationRef: 'rec-1',
    });
  });

  test('lookup found resolves an unknown submission to acknowledgement', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-1' };
    const lookup: OrderLookup = { kind: 'found', externalOrderId: 'ERP-001' };

    assert.deepEqual(decideSubmissionFollowUp(unknown, lookup), {
      kind: 'acknowledge',
      externalOrderId: 'ERP-001',
    });
  });

  test('retry requires both authoritative not-found evidence and adapter permission', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-1' };
    const permitted: OrderLookup = {
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: true,
    };
    const forbidden: OrderLookup = {
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: false,
    };

    assert.deepEqual(decideSubmissionFollowUp(unknown, permitted, retryCapability), {
      kind: 'retry_same_reference',
      authoritativeAt: '2026-09-11T10:10:00Z',
    });
    assert.deepEqual(decideSubmissionFollowUp(unknown, forbidden), {
      kind: 'human_review',
      reconciliationRef: 'rec-1',
    });
  });

  test('network retry permission cannot authorize retry without trusted capability', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-1' };
    const lookup: OrderLookup = {
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: true,
    };

    assert.deepEqual(decideSubmissionFollowUp(unknown, lookup), {
      kind: 'human_review',
      reconciliationRef: 'rec-1',
    });
    assert.deepEqual(decideSubmissionFollowUp(unknown, lookup, {
      authoritativeLookupSupported: false,
      retryAfterAuthoritativeNotFound: true,
    }), {
      kind: 'human_review',
      reconciliationRef: 'rec-1',
    });
  });

  test('trusted capability cannot override an explicit adapter retry refusal', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-1' };
    const lookup: OrderLookup = {
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: false,
    };

    assert.deepEqual(decideSubmissionFollowUp(unknown, lookup, retryCapability), {
      kind: 'human_review',
      reconciliationRef: 'rec-1',
    });
  });

  test('inconclusive lookup stays in human review without blind retry', () => {
    const unknown: SubmitResult = { kind: 'unknown', reconciliationRef: 'rec-submit' };
    const lookup: OrderLookup = { kind: 'inconclusive', reconciliationRef: 'rec-lookup' };

    assert.deepEqual(decideSubmissionFollowUp(unknown, lookup), {
      kind: 'human_review',
      reconciliationRef: 'rec-lookup',
    });
  });

  test('lookup evidence cannot override an already terminal submission result', () => {
    const rejected: SubmitResult = { kind: 'rejected', code: 'INVALID', message: 'Invalid' };
    const lookup: OrderLookup = {
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: true,
    };

    assert.deepEqual(decideSubmissionFollowUp(rejected, lookup), { kind: 'reject', code: 'INVALID' });
  });

  test('strictly validates untrusted submit results', () => {
    assert.deepEqual(validateSubmitResult({ kind: 'accepted', externalOrderId: 'ERP-1' }), {
      ok: true,
      value: { kind: 'accepted', externalOrderId: 'ERP-1' },
    });
    for (const input of [
      { kind: 'accepted', externalOrderId: '' },
      { kind: 'accepted', externalOrderId: 'ERP-1', injected: true },
      { kind: 'rejected', code: 'NO', message: 4 },
      { kind: 'unknown' },
      { kind: 'other', reconciliationRef: 'rec-1' },
      null,
    ]) {
      assert.equal(validateSubmitResult(input).ok, false);
    }
  });

  test('strictly validates untrusted lookup results', () => {
    assert.equal(validateOrderLookup({
      kind: 'not_found',
      authoritativeAt: '2026-09-11T10:10:00Z',
      retryPermitted: true,
    }).ok, true);
    for (const input of [
      { kind: 'found', externalOrderId: 'ERP-1', injected: true },
      { kind: 'not_found', authoritativeAt: '', retryPermitted: true },
      { kind: 'not_found', authoritativeAt: '2026-02-30T10:10:00Z', retryPermitted: true },
      { kind: 'not_found', authoritativeAt: '2026-09-11T13:10:00+03:00', retryPermitted: true },
      { kind: 'not_found', authoritativeAt: '2026-09-11T10:10:00Z', retryPermitted: 'yes' },
      { kind: 'inconclusive', reconciliationRef: '' },
      [],
    ]) {
      assert.equal(validateOrderLookup(input).ok, false);
    }
  });
});
