import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_DELIVERY_DEFERRALS,
  MAX_OPEN_EPISODES_PER_INSTALLATION,
  alertSignalFingerprint,
  classifySignalIdentity,
  planAlertAcceptance,
  planDeliveryAttempt,
  planEpisodeResolution,
  validateAlertSignal,
  type AcceptanceContext,
} from '../src/acceptance.ts';
import { resolveNotificationPolicy, type NotificationPolicyRecord } from '../src/policy.ts';
import type { AlertEpisode, AlertSignal } from '../../alerting/src/alert-episode.ts';

// The planning layer is everything the repository decides before it writes a row. Keeping it pure
// means the concurrency, restart and quiet-window cases below are decided by argument, never by the
// machine the process happens to run on.

const installationId = '50000000-0000-4000-8000-000000000001';
const now = '2026-09-12T12:00:00.000Z';

const signal: AlertSignal = {
  signalId: 'sig-0001',
  installationId,
  conditionKey: `${installationId}:SYN-A`,
  severity: 'actionable',
  observedAt: '2026-09-12T11:59:00.000Z',
  subject: 'Amoxicillin 500mg',
  detail: 'On hand 2 of target 10',
};

const record: NotificationPolicyRecord = {
  status: 'active',
  timeZone: 'Africa/Cairo',
  quietHoursEnabled: true,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  bypassSeverities: ['critical'],
};

/** What the repository reads under the per-installation lock before a first signal. */
const fresh: AcceptanceContext = { openEpisode: null, episodeSequence: 0, openEpisodeCount: 0 };

function policyOf(overrides: Partial<NotificationPolicyRecord> = {}) {
  const resolution = resolveNotificationPolicy({ ...record, ...overrides });
  assert.equal(resolution.kind, 'resolved', 'this helper is for policies expected to resolve');
  return resolution;
}

function invalidReason(overrides: Partial<AlertSignal>, instant = now): string {
  const outcome = validateAlertSignal({ ...signal, ...overrides }, instant);
  assert.equal(outcome.kind, 'invalid', `expected refusal, received ${outcome.kind}`);
  return outcome.kind === 'invalid' ? outcome.reason : '';
}

function openOne(instant = signal.observedAt) {
  const plan = planAlertAcceptance(fresh, { ...signal, observedAt: instant }, policyOf(), now);
  assert.equal(plan.kind, 'opened');
  if (plan.kind !== 'opened') throw new Error('unreachable');
  return plan;
}

/** The context the repository reads once the first episode has committed. */
function afterOpening(episode: AlertEpisode, openEpisodeCount = 1): AcceptanceContext {
  return { openEpisode: episode, episodeSequence: 1, openEpisodeCount };
}

describe('alert signal validation', () => {
  it('accepts a well-formed synthetic signal', () => {
    assert.equal(validateAlertSignal(signal, now).kind, 'valid');
  });

  it('refuses empty and oversized identifiers', () => {
    assert.equal(invalidReason({ signalId: '' }), 'invalid_identifier');
    assert.equal(invalidReason({ signalId: 'x'.repeat(129) }), 'invalid_identifier');
    assert.equal(invalidReason({ installationId: '' }), 'invalid_identifier');
    assert.equal(invalidReason({ conditionKey: 'x'.repeat(257) }), 'invalid_identifier');
  });

  it('refuses an identifier carrying a null byte used to forge a composite key', () => {
    assert.equal(invalidReason({ conditionKey: `a${String.fromCharCode(0)}b` }), 'invalid_identifier');
  });

  it('refuses a non-string identifier from an untyped caller before it reaches a query', () => {
    assert.equal(invalidReason({ signalId: 42 as unknown as string }), 'invalid_identifier');
    assert.equal(invalidReason({ conditionKey: { key: 'x' } as unknown as string }), 'invalid_identifier');
  });

  it('refuses an unknown severity', () => {
    assert.equal(invalidReason({ severity: 'urgent' as AlertSignal['severity'] }), 'invalid_severity');
  });

  it('bounds the free-text fields the reducer itself does not bound', () => {
    assert.equal(invalidReason({ subject: 'x'.repeat(257) }), 'signal_too_large');
    assert.equal(invalidReason({ detail: 'x'.repeat(2049) }), 'signal_too_large');
    assert.equal(invalidReason({ subject: 7 as unknown as string }), 'signal_too_large');
  });

  it('requires a strict instant rather than anything Date happens to parse', () => {
    assert.equal(invalidReason({ observedAt: '2026' }), 'invalid_instant');
    assert.equal(invalidReason({ observedAt: '12 September 2026' }), 'invalid_instant');
    assert.equal(invalidReason({ observedAt: 'not-a-date' }), 'invalid_instant');
    assert.equal(validateAlertSignal({ ...signal, observedAt: '2026-09-12T13:59:00+02:00' }, now).kind, 'valid');
  });

  it('refuses a signal older than the retention bound instead of waking someone about last month', () => {
    assert.equal(invalidReason({ observedAt: '2026-07-01T00:00:00.000Z' }), 'stale_signal');
  });

  it('refuses a signal dated beyond tolerated clock skew', () => {
    assert.equal(invalidReason({ observedAt: '2026-09-12T12:30:00.000Z' }), 'future_signal');
    // A minute of skew is tolerated, because two synthetic clocks never agree exactly.
    assert.equal(validateAlertSignal({ ...signal, observedAt: '2026-09-12T12:01:00.000Z' }, now).kind, 'valid');
  });

  it('refuses when the reference instant itself is unusable', () => {
    assert.equal(invalidReason({}, 'not-a-date'), 'invalid_instant');
  });
});

describe('signal identity', () => {
  it('produces a stable fingerprint for the same content', () => {
    assert.equal(alertSignalFingerprint(signal), alertSignalFingerprint({ ...signal }));
    assert.match(alertSignalFingerprint(signal), /^[0-9a-f]{64}$/);
  });

  it('changes the fingerprint when any meaningful field changes', () => {
    const base = alertSignalFingerprint(signal);
    for (const change of [
      { severity: 'critical' as const }, { subject: 'Other' }, { detail: 'Other' },
      { conditionKey: `${installationId}:SYN-B` }, { observedAt: '2026-09-12T11:58:00.000Z' },
    ]) {
      assert.notEqual(alertSignalFingerprint({ ...signal, ...change }), base, JSON.stringify(change));
    }
  });

  it('is not confused by content shifted across adjacent fields', () => {
    const shifted = { ...signal, subject: 'ab', detail: 'c' };
    const other = { ...signal, subject: 'a', detail: 'bc' };
    assert.notEqual(alertSignalFingerprint(shifted), alertSignalFingerprint(other));
  });

  it('classifies a replay of identical content as a duplicate', () => {
    assert.equal(classifySignalIdentity(alertSignalFingerprint(signal), signal), 'duplicate');
  });

  it('classifies a changed body under a reused identity as conflicting', () => {
    const stored = alertSignalFingerprint(signal);
    assert.equal(classifySignalIdentity(stored, { ...signal, detail: 'On hand 1 of target 10' }), 'conflicting');
  });

  it('classifies an unseen identity as new', () => {
    assert.equal(classifySignalIdentity(null, signal), 'new');
  });
});

describe('alert acceptance planning', () => {
  it('opens an episode with a scheduled delivery outside the quiet window', () => {
    const plan = openOne();
    assert.equal(plan.episode.signalCount, 1);
    assert.equal(plan.episode.status, 'open');
    assert.equal(plan.episode.episodeId, 'ep-1');
    assert.equal(plan.delivery.deferred, false);
    assert.equal(plan.delivery.deliverAt, signal.observedAt);
    assert.equal(plan.episodeSequence, 1);
  });

  it('never puts signal content into the planned delivery', () => {
    const plan = openOne();
    const serialised = JSON.stringify(plan.delivery);
    for (const secret of [signal.subject, signal.detail, signal.conditionKey]) {
      assert.equal(serialised.toLowerCase().includes(secret.toLowerCase()), false, `leaked ${secret}`);
    }
  });

  it('coalesces a second signal for the same condition and schedules nothing more', () => {
    const first = openOne();
    const plan = planAlertAcceptance(
      afterOpening(first.episode),
      { ...signal, signalId: 'sig-0002', observedAt: '2026-09-12T11:59:30.000Z' },
      policyOf(),
      now,
    );
    assert.equal(plan.kind, 'coalesced');
    if (plan.kind !== 'coalesced') return;
    assert.equal(plan.episode.signalCount, 2);
    assert.equal(plan.episode.episodeId, first.episode.episodeId);
    assert.equal(plan.episodeSequence, 1, 'coalescing mints no new episode sequence');
  });

  it('escalates severity inside an open episode without scheduling a second delivery', () => {
    const first = openOne();
    const plan = planAlertAcceptance(
      afterOpening(first.episode),
      { ...signal, signalId: 'sig-0003', severity: 'critical', observedAt: '2026-09-12T11:59:30.000Z' },
      policyOf(),
      now,
    );
    assert.equal(plan.kind, 'coalesced');
    if (plan.kind !== 'coalesced') return;
    assert.equal(plan.episode.severity, 'critical');
  });

  it('opens the next sequence when the condition has no open episode', () => {
    const plan = planAlertAcceptance(
      { openEpisode: null, episodeSequence: 41, openEpisodeCount: 3 }, signal, policyOf(), now,
    );
    assert.equal(plan.kind, 'opened');
    if (plan.kind !== 'opened') return;
    assert.equal(plan.episode.episodeId, 'ep-42');
    assert.equal(plan.episodeSequence, 42);
  });

  it('refuses a context whose open episode belongs to a different condition rather than merging them', () => {
    const first = openOne();
    assert.throws(
      () => planAlertAcceptance(afterOpening({ ...first.episode, conditionKey: 'other' }), signal, policyOf(), now),
      /does not match/,
    );
    assert.throws(
      () => planAlertAcceptance(afterOpening({ ...first.episode, status: 'resolved' }), signal, policyOf(), now),
      /does not match/,
    );
  });

  it('defers a quiet-hours signal to the first minute outside the window', () => {
    // 23:30 local in Cairo; the window ends at 07:00 local, which is 04:00Z in September.
    const plan = planAlertAcceptance(
      fresh,
      { ...signal, observedAt: '2026-09-12T20:30:00.000Z' },
      policyOf(),
      '2026-09-12T20:31:00.000Z',
    );
    assert.equal(plan.kind, 'opened');
    if (plan.kind !== 'opened') return;
    assert.equal(plan.delivery.deferred, true);
    assert.equal(plan.delivery.deliverAt, '2026-09-13T04:00:00.000Z');
  });

  it('passes a bypass severity straight through the quiet window', () => {
    const plan = planAlertAcceptance(
      fresh,
      { ...signal, severity: 'critical', observedAt: '2026-09-12T20:30:00.000Z' },
      policyOf(),
      '2026-09-12T20:31:00.000Z',
    );
    assert.equal(plan.kind, 'opened');
    if (plan.kind !== 'opened') return;
    assert.equal(plan.delivery.deferred, false);
  });

  it('finds the one free minute of a window that covers almost the whole day', () => {
    // The resolver forbids a window with equal ends, so a policy can never suppress delivery for a
    // whole day. 00:00-23:59 local leaves 23:59, which is 20:59Z in Cairo in September.
    const plan = planAlertAcceptance(fresh, signal, policyOf({ quietStartMinute: 0, quietEndMinute: 1439 }), now);
    assert.equal(plan.kind, 'opened');
    if (plan.kind !== 'opened') return;
    assert.equal(plan.delivery.deliverAt, '2026-09-12T20:59:00.000Z');
    assert.equal(plan.delivery.deferred, true);
  });

  it('records the episode without a delivery when the policy is unusable', () => {
    for (const [overrides, reason] of [
      [{ timeZone: 'Mars/Olympus' }, 'invalid_time_zone'],
      [{ status: 'draft' }, 'policy_inactive'],
      [{ quietStartMinute: -1 }, 'invalid_quiet_window'],
    ] as const) {
      const plan = planAlertAcceptance(fresh, signal, resolveNotificationPolicy({ ...record, ...overrides }), now);
      assert.equal(plan.kind, 'opened_without_delivery', `${reason} must not schedule a delivery`);
      if (plan.kind !== 'opened_without_delivery') return;
      assert.equal(plan.reason, reason);
      // The alert is not lost: the episode is still opened and can be seen in the application.
      assert.equal(plan.episode.status, 'open');
      assert.equal(plan.episode.signalCount, 1);
    }
  });

  it('records the episode without a delivery when no policy row exists at all', () => {
    const plan = planAlertAcceptance(fresh, signal, resolveNotificationPolicy(null), now);
    assert.equal(plan.kind, 'opened_without_delivery');
    if (plan.kind !== 'opened_without_delivery') return;
    assert.equal(plan.reason, 'policy_missing');
  });

  it('coalesces into an open episode even when the policy is unusable', () => {
    const first = openOne();
    const plan = planAlertAcceptance(
      afterOpening(first.episode), { ...signal, signalId: 'sig-0004' }, resolveNotificationPolicy(null), now,
    );
    assert.equal(plan.kind, 'coalesced');
  });

  it('refuses an invalid signal before it can reach any state', () => {
    const plan = planAlertAcceptance(fresh, { ...signal, signalId: '' }, policyOf(), now);
    assert.equal(plan.kind, 'refused');
    if (plan.kind !== 'refused') return;
    assert.equal(plan.reason, 'invalid_identifier');
  });

  it('refuses a new condition once the per-installation open-episode bound is reached', () => {
    const plan = planAlertAcceptance(
      { openEpisode: null, episodeSequence: 5_000, openEpisodeCount: MAX_OPEN_EPISODES_PER_INSTALLATION },
      signal, policyOf(), now,
    );
    assert.equal(plan.kind, 'refused');
    if (plan.kind !== 'refused') return;
    assert.equal(plan.reason, 'episode_capacity_exceeded');
  });

  // Regression, finding E2. The lane counted every episode ever recorded in one JSON document,
  // resolved or not, and never removed any. After 2000 distinct conditions an installation refused
  // every new shortage for the rest of its life. Only open episodes occupy capacity now.
  it('does not count resolved episodes against the bound', () => {
    const plan = planAlertAcceptance(
      { openEpisode: null, episodeSequence: MAX_OPEN_EPISODES_PER_INSTALLATION + 500, openEpisodeCount: 0 },
      signal, policyOf(), now,
    );
    assert.equal(plan.kind, 'opened');
  });

  it('still coalesces into an existing episode when the bound is reached', () => {
    const first = openOne();
    const plan = planAlertAcceptance(
      afterOpening(first.episode, MAX_OPEN_EPISODES_PER_INSTALLATION), { ...signal, signalId: 'sig-5' }, policyOf(), now,
    );
    assert.equal(plan.kind, 'coalesced');
  });

  it('refuses an unusable stored sequence instead of minting a colliding episode reference', () => {
    for (const episodeSequence of [-1, 1.5, Number.NaN]) {
      const plan = planAlertAcceptance({ ...fresh, episodeSequence }, signal, policyOf(), now);
      assert.equal(plan.kind, 'refused');
      if (plan.kind !== 'refused') return;
      assert.equal(plan.reason, 'invalid_episode_context');
    }
  });
});

describe('episode resolution planning', () => {
  it('resolves an open episode through the reducer and keeps its identity', () => {
    const first = openOne();
    const plan = planEpisodeResolution(first.episode, '2026-09-12T13:00:00.000Z');
    assert.equal(plan.kind, 'resolved');
    if (plan.kind !== 'resolved') return;
    assert.equal(plan.episode.status, 'resolved');
    assert.equal(plan.episode.episodeId, first.episode.episodeId);
  });

  it('reports that nothing is open rather than inventing an episode', () => {
    assert.deepEqual(planEpisodeResolution(null, now), { kind: 'not_open' });
  });

  it('refuses an unusable resolution instant', () => {
    assert.deepEqual(planEpisodeResolution(openOne().episode, '2026'), { kind: 'refused', reason: 'invalid_instant' });
  });
});

describe('delivery attempt planning', () => {
  const attempt = (overrides: Partial<Parameters<typeof planDeliveryAttempt>[0]> = {}) => planDeliveryAttempt({
    severity: 'actionable',
    deliverAt: '2026-09-12T12:00:00.000Z',
    now: '2026-09-12T12:00:00.000Z',
    deferrals: 0,
    resolution: resolveNotificationPolicy(record),
    ...overrides,
  });

  it('waits while the scheduled instant is still in the future', () => {
    assert.equal(attempt({ now: '2026-09-12T11:59:59.999Z' }).kind, 'wait');
  });

  it('sends a due delivery outside the quiet window', () => {
    assert.equal(attempt().kind, 'send');
  });

  it('sends a deferred delivery at exactly the instant the window ends', () => {
    // 07:00 local is the first minute outside a 22:00-07:00 window.
    assert.equal(attempt({ deliverAt: '2026-09-13T04:00:00.000Z', now: '2026-09-13T04:00:00.000Z', deferrals: 1 }).kind, 'send');
    assert.equal(attempt({ deliverAt: '2026-09-13T04:00:00.000Z', now: '2026-09-13T03:59:59.999Z', deferrals: 1 }).kind, 'wait');
  });

  it('re-defers a delivery that came due inside the quiet window after a delay', () => {
    // Scheduled for noon but only dispatched at 23:30 local, which is inside the window.
    const plan = attempt({ now: '2026-09-12T20:30:00.000Z' });
    assert.equal(plan.kind, 'defer');
    assert.equal(plan.kind === 'defer' ? plan.deliverAt : '', '2026-09-13T04:00:00.000Z');
  });

  it('sends a bypass severity that came due inside the quiet window', () => {
    assert.equal(attempt({ now: '2026-09-12T20:30:00.000Z', severity: 'critical' }).kind, 'send');
  });

  it('holds rather than sends when the policy became unusable after scheduling', () => {
    const plan = attempt({ resolution: resolveNotificationPolicy({ ...record, timeZone: 'Mars/Olympus' }) });
    assert.equal(plan.kind, 'hold');
    assert.equal(plan.kind === 'hold' ? plan.reason : '', 'invalid_time_zone');
  });

  it('holds when the policy row disappeared entirely', () => {
    const plan = attempt({ resolution: resolveNotificationPolicy(null) });
    assert.equal(plan.kind, 'hold');
    assert.equal(plan.kind === 'hold' ? plan.reason : '', 'policy_missing');
  });

  it('holds instead of deferring forever once the deferral bound is reached', () => {
    const plan = attempt({ now: '2026-09-12T20:30:00.000Z', deferrals: MAX_DELIVERY_DEFERRALS });
    assert.equal(plan.kind, 'hold');
    assert.equal(plan.kind === 'hold' ? plan.reason : '', 'defer_limit_exceeded');
  });

  it('holds on an unusable stored instant rather than sending immediately', () => {
    assert.equal(attempt({ deliverAt: 'not-a-date' }).kind, 'hold');
    assert.equal(attempt({ now: 'not-a-date' }).kind, 'hold');
  });

  it('names an unusable deferral counter instead of reporting it as a bad instant', () => {
    const plan = attempt({ deferrals: -1 });
    assert.equal(plan.kind === 'hold' ? plan.reason : '', 'invalid_deferral_count');
  });
});
