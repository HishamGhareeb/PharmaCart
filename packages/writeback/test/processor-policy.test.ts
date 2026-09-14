import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  callWithDeadline,
  classifyApplyFailure,
  classifyLookupFailure,
  describeFailure,
  resolveWritebackProcessorOptions,
  writebackProcessorLimits,
} from '../src/processor-policy.ts';

// The processor decides whether a receipt may be sent again from these rules alone, so they are pinned
// here without a database: every bound is finite and validated, a sink call cannot outlive its lease, a
// hung sink is cut off, and no failure the sink does not explicitly describe is read as "nothing sent".

test('defaults are inside their own bounds and keep a sink call shorter than its lease', () => {
  const resolved = resolveWritebackProcessorOptions();
  for (const [name, limit] of Object.entries(writebackProcessorLimits)) {
    const value = resolved[name as keyof typeof resolved];
    assert.equal(value, limit.default, `${name} must default to its documented value`);
    assert.ok(value >= limit.min && value <= limit.max, `${name} default must be inside its bound`);
  }
  assert.ok(resolved.sinkCallTimeoutMs * 2 <= resolved.leaseMs);
});

test('an unbounded, fractional, unknown or inconsistent option is refused at construction', () => {
  const unusable: Record<string, unknown>[] = [
    { leaseMs: Number.NaN }, { leaseMs: Number.POSITIVE_INFINITY }, { leaseMs: 999 }, { leaseMs: 600_001 }, { leaseMs: 1_500.5 },
    { maxAttempts: 0 }, { maxAttempts: 101 }, { maxAttempts: 2.5 },
    { batch: 0 }, { batch: 201 },
    { lockTimeoutMs: 99 }, { lockTimeoutMs: 60_001 },
    { sinkCallTimeoutMs: 49 }, { sinkCallTimeoutMs: 300_001 }, { sinkCallTimeoutMs: Number.NaN },
    { retryDelayMs: -1 }, { retryDelayMs: 3_600_001 }, { retryDelayMs: '5' },
    // A sink call that could still be running when its lease expires would let a second worker act on a
    // receipt whose send is genuinely unfinished.
    { leaseMs: 1_000, sinkCallTimeoutMs: 501 },
    { leaseMs: 30_000, sinkCallTimeoutMs: 20_000 },
    { lease: 30_000 },
    { allowResend: true },
  ];
  for (const options of unusable) {
    assert.throws(() => resolveWritebackProcessorOptions(options as never), RangeError, `expected ${JSON.stringify(options)} to be refused`);
  }
  assert.deepEqual(
    resolveWritebackProcessorOptions({ leaseMs: 1_000, sinkCallTimeoutMs: 500, retryDelayMs: 0, maxAttempts: 1, batch: 1, lockTimeoutMs: 100 }),
    { leaseMs: 1_000, sinkCallTimeoutMs: 500, retryDelayMs: 0, maxAttempts: 1, batch: 1, lockTimeoutMs: 100 },
  );
});

test('a sink call that never settles is cut off at its deadline', async () => {
  const started = process.hrtime.bigint();
  const result = await callWithDeadline(() => new Promise<never>(() => undefined), 60);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(result, { kind: 'timed_out', afterMs: 60 });
  assert.ok(elapsed >= 50 && elapsed < 5_000, `the deadline must bound the wait, waited ${elapsed}ms`);
});

test('an answer and a failure are reported as such, including a synchronous throw', async () => {
  assert.deepEqual(await callWithDeadline(async () => 'evidence', 1_000), { kind: 'answered', value: 'evidence' });
  const failure = new Error('synthetic failure');
  assert.deepEqual(await callWithDeadline(async () => { throw failure; }, 1_000), { kind: 'failed', error: failure });
  const sync = await callWithDeadline(() => { throw failure; }, 1_000);
  assert.deepEqual(sync, { kind: 'failed', error: failure });
  // An absent result is still an answer: "the sink holds nothing" is not a failure to reply.
  assert.deepEqual(await callWithDeadline(async () => undefined, 1_000), { kind: 'answered', value: undefined });
  for (const deadline of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(callWithDeadline(async () => 1, deadline), RangeError);
  }
});

test('only an explicit not-recorded refusal permits another send; everything unrecognised is unknown', () => {
  const coded = (code: string) => ({ kind: 'failed' as const, error: Object.assign(new Error(`synthetic ${code}`), { code }) });
  assert.equal(classifyApplyFailure(coded('SINK_LEDGER_LOCKED')).kind, 'not_recorded');
  for (const [code, reason] of [
    ['SINK_RECEIPT_CONFLICT', 'sink_receipt_conflict'],
    ['SINK_LEDGER_CORRUPT', 'sink_ledger_corrupt'],
    ['SINK_LEDGER_TOO_LARGE', 'sink_ledger_too_large'],
    ['WRITEBACK_PAYLOAD_INVALID', 'payload_invalid'],
  ] as const) {
    assert.deepEqual({ ...classifyApplyFailure(coded(code)), detail: '' }, { kind: 'refused', reason, detail: '' });
  }
  // An uncertain apply, a transport error, an error with no code, a thrown non-error and a timeout must
  // all be treated as "may have been recorded". None may be read as permission to resend.
  for (const call of [
    coded('SINK_APPLY_UNCERTAIN'), coded('ECONNRESET'), coded('EPERM'),
    { kind: 'failed' as const, error: new Error('no code') },
    { kind: 'failed' as const, error: 'a string' },
    { kind: 'failed' as const, error: null },
    { kind: 'failed' as const, error: { code: 7 } },
  ]) {
    const classified = classifyApplyFailure(call);
    assert.equal(classified.kind, 'no_answer', `expected ${describeFailure(call)} to be unknown`);
    assert.equal(classified.reason, 'sink_no_answer');
  }
  const timeout = classifyApplyFailure({ kind: 'timed_out', afterMs: 10 });
  assert.equal(timeout.kind, 'no_answer');
  assert.equal(timeout.reason, 'sink_timeout');
});

test('a failed lookup is inconclusive and its recorded detail is bounded to one line', () => {
  assert.equal(classifyLookupFailure({ kind: 'timed_out', afterMs: 5 }).reason, 'lookup_timeout');
  const long = classifyLookupFailure({ kind: 'failed', error: Object.assign(new Error(`line one\nline two ${'x'.repeat(4_000)}`), { code: 'SINK_LEDGER_LOCKED' }) });
  assert.equal(long.reason, 'lookup_unavailable');
  assert.ok(long.detail.length <= 1024, 'the recorded detail must fit the attempt column');
  assert.doesNotMatch(long.detail, /[\r\n]/);
  assert.match(long.detail, /^SINK_LEDGER_LOCKED: line one line two/);
});
