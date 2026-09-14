import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callWithin,
  MAX_LOOKUP_FAILURES,
  planPreSendLookup,
  planReconciliation,
  reconciliationEligibility,
  resolveDispatcherOptions,
  resolveLockTimeoutMs,
} from '../src/dispatch.ts';

// Everything the dispatcher decides about an unsettled delivery, as pure functions. The database
// layer only reads the row, asks the sink, and applies one of these plans under a version guard.

const now = '2026-09-12T12:00:00.000Z';

describe('reconciliation eligibility', () => {
  // Regression, finding C1. The lane's recovery looked up every `dispatching` row, including one a
  // live worker was still sending. A not-found answer that predates the send demoted it to
  // outcome_unknown and, on the next pass, to manual_review, although the send then succeeded.
  it('does not reconcile a dispatching row whose lease is still live', () => {
    assert.deepEqual(
      reconciliationEligibility({ status: 'dispatching', leaseExpiresAt: '2026-09-12T12:00:00.001Z' }, now),
      { kind: 'ineligible', reason: 'lease_active' },
    );
  });

  it('reconciles a dispatching row once its lease has expired, and any outcome_unknown row', () => {
    assert.deepEqual(reconciliationEligibility({ status: 'dispatching', leaseExpiresAt: now }, now), { kind: 'eligible' });
    assert.deepEqual(reconciliationEligibility({ status: 'outcome_unknown', leaseExpiresAt: null }, now), { kind: 'eligible' });
  });

  it('never reconciles a settled, pending or held row', () => {
    for (const status of ['pending', 'delivered', 'manual_review', 'held']) {
      assert.deepEqual(
        reconciliationEligibility({ status, leaseExpiresAt: null }, now),
        { kind: 'ineligible', reason: 'not_unsettled' },
        status,
      );
    }
  });

  it('refuses to decide on an unusable lease or clock instead of treating it as expired', () => {
    assert.deepEqual(
      reconciliationEligibility({ status: 'dispatching', leaseExpiresAt: null }, now),
      { kind: 'ineligible', reason: 'invalid_instant' },
    );
    assert.deepEqual(
      reconciliationEligibility({ status: 'dispatching', leaseExpiresAt: now }, 'not-a-date'),
      { kind: 'ineligible', reason: 'invalid_instant' },
    );
  });
});

describe('reconciliation planning', () => {
  const row = { status: 'outcome_unknown' as const, sendAttempted: true, lookupFailures: 0 };

  it('settles any unsettled row the sink already holds', () => {
    assert.deepEqual(planReconciliation(row, 'found'), { kind: 'settle_delivered' });
    assert.deepEqual(planReconciliation({ ...row, status: 'dispatching' }, 'found'), { kind: 'settle_delivered' });
  });

  // Regression, finding C2. A worker that crashed after claiming a row but before recording any
  // send left it `dispatching`. The lane moved it to outcome_unknown and then manual_review, so a
  // notification that was provably never sent was never sent at all.
  it('releases an abandoned claim that never recorded a send back to pending', () => {
    assert.deepEqual(
      planReconciliation({ status: 'dispatching', sendAttempted: false, lookupFailures: 0 }, 'not_found'),
      { kind: 'release', reason: 'claim_abandoned' },
    );
  });

  it('marks an expired send whose outcome was never recorded as unknown, never as sendable', () => {
    assert.deepEqual(
      planReconciliation({ status: 'dispatching', sendAttempted: true, lookupFailures: 0 }, 'not_found'),
      { kind: 'mark_unknown', reason: 'lease_expired_unsettled' },
    );
  });

  it('escalates an unknown outcome the sink cannot find to manual review, never to a resend', () => {
    assert.deepEqual(planReconciliation(row, 'not_found'), { kind: 'manual_review', reason: 'not_found_after_unknown' });
  });

  // Regression, finding R1. A lookup that kept failing left the row outcome_unknown forever and
  // every pass asked again: an unbounded retry with no record of how many times it had been tried.
  it('bounds failed lookups and escalates when the budget is spent', () => {
    assert.deepEqual(planReconciliation(row, 'failed'), { kind: 'record_lookup_failure' });
    assert.deepEqual(
      planReconciliation({ ...row, lookupFailures: MAX_LOOKUP_FAILURES - 2 }, 'failed'),
      { kind: 'record_lookup_failure' },
    );
    assert.deepEqual(
      planReconciliation({ ...row, lookupFailures: MAX_LOOKUP_FAILURES - 1 }, 'failed'),
      { kind: 'manual_review', reason: 'lookup_attempts_exhausted' },
    );
  });
});

describe('lookup before the first send', () => {
  // Regression, finding D1. The lane sent a never-attempted row without asking the sink. After a
  // database restore the row is `pending` again although the sink already delivered it, so a
  // provider without idempotent accept would push the same alert twice.
  it('settles instead of sending when the sink already holds the delivery', () => {
    assert.deepEqual(planPreSendLookup('found', 0), { kind: 'settle_delivered' });
  });

  it('sends only after the sink answered that it does not hold the delivery', () => {
    assert.deepEqual(planPreSendLookup('not_found', 0), { kind: 'send' });
  });

  it('releases the claim without sending when the lookup cannot be answered, within a bound', () => {
    assert.deepEqual(planPreSendLookup('failed', 0), { kind: 'release', reason: 'lookup_failed' });
    assert.deepEqual(
      planPreSendLookup('failed', MAX_LOOKUP_FAILURES - 1),
      { kind: 'manual_review', reason: 'lookup_attempts_exhausted' },
    );
  });
});

describe('dispatcher configuration', () => {
  it('resolves defaults that satisfy every bound', () => {
    assert.deepEqual(resolveDispatcherOptions({}), {
      leaseMs: 60_000, batchSize: 20, sinkTimeoutMs: 5_000, lockTimeoutMs: 5_000, allowSyntheticSink: false,
    });
  });

  it('refuses bounds that cannot bound anything', () => {
    for (const options of [
      { leaseMs: 999 }, { leaseMs: 15 * 60_000 + 1 }, { leaseMs: Number.NaN },
      { batchSize: 0 }, { batchSize: 101 }, { batchSize: 1.5 },
      { sinkTimeoutMs: 0 }, { sinkTimeoutMs: Number.POSITIVE_INFINITY }, { sinkTimeoutMs: 60_001 },
      { lockTimeoutMs: 0 }, { lockTimeoutMs: 30_001 },
    ]) {
      assert.throws(() => resolveDispatcherOptions(options), RangeError, JSON.stringify(options));
    }
  });

  // Regression, finding R2. The lane called the sink with no deadline at all, so a hung provider
  // held the worker forever and the lease that was meant to describe the attempt expired under it.
  it('requires the lookup and the send together to finish inside the lease', () => {
    assert.throws(() => resolveDispatcherOptions({ leaseMs: 10_000, sinkTimeoutMs: 5_000 }), RangeError);
    assert.equal(resolveDispatcherOptions({ leaseMs: 10_001, sinkTimeoutMs: 5_000 }).sinkTimeoutMs, 5_000);
  });

  it('bounds the acceptance lock wait', () => {
    assert.equal(resolveLockTimeoutMs(undefined), 5_000);
    assert.equal(resolveLockTimeoutMs(250), 250);
    for (const value of [0, -1, 1.5, 30_001, Number.NaN]) assert.throws(() => resolveLockTimeoutMs(value), RangeError);
  });
});

describe('bounded sink calls', () => {
  it('returns the value of a call that finishes in time', async () => {
    assert.deepEqual(await callWithin(async () => 7, 1_000), { kind: 'returned', value: 7 });
  });

  it('reports a thrown error, including one thrown synchronously, as data', async () => {
    const failure = new Error('refused');
    assert.deepEqual(await callWithin(async () => { throw failure; }, 1_000), { kind: 'threw', error: failure });
    assert.deepEqual(await callWithin(() => { throw failure; }, 1_000), { kind: 'threw', error: failure });
  });

  it('abandons a call that never settles within its bound', async () => {
    const started = process.hrtime.bigint();
    const outcome = await callWithin(() => new Promise<never>(() => undefined), 25);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(outcome, { kind: 'timed_out' });
    assert.ok(elapsedMs >= 20 && elapsedMs < 2_000, `abandoned after ${elapsedMs}ms`);
  });

  it('does not surface a late rejection from an abandoned call', async () => {
    let reject: (error: Error) => void = () => undefined;
    const outcome = await callWithin(() => new Promise<never>((_, fail) => { reject = fail; }), 5);
    assert.deepEqual(outcome, { kind: 'timed_out' });
    reject(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
