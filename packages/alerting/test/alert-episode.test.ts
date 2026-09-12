import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAlertSignal,
  emptyAlertState,
  resolveAlertCondition,
  type AlertPolicy,
  type AlertSignal,
  type AlertState,
} from '../src/alert-episode.ts';

const policy: AlertPolicy = {
  quietHours: { timeZone: 'Africa/Cairo', startMinute: 22 * 60, endMinute: 7 * 60 },
  bypassSeverities: ['critical'],
};

const SENSITIVE_SUBJECT = 'Syntheticol 10 mg tablet';
const SENSITIVE_DETAIL = 'Only 2 boxes left at Nile Street branch';

function signal(override: Partial<AlertSignal> = {}): AlertSignal {
  return {
    signalId: 'sig-1',
    installationId: 'inst-branch-01',
    conditionKey: 'shortage:pack-10',
    severity: 'actionable',
    observedAt: '2026-09-12T20:30:00Z',
    subject: SENSITIVE_SUBJECT,
    detail: SENSITIVE_DETAIL,
    ...override,
  };
}

function openedState(state: AlertState, input: AlertSignal): AlertState {
  const result = applyAlertSignal(state, input, policy);
  assert.notEqual(result.kind, 'rejected', result.kind === 'rejected' ? result.reason : '');
  return result.state;
}

describe('AC-017 repeated alerts during quiet hours', () => {
  it('yields one episode, one deferred delivery and no sensitive payload', () => {
    let state = emptyAlertState();
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      state = openedState(state, signal({
        signalId: `sig-${repeat}`,
        observedAt: `2026-09-12T20:3${repeat}:00Z`,
      }));
    }

    const episodes = Object.values(state.episodes);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.signalCount, 5);
    assert.equal(episodes[0]?.status, 'open');

    assert.equal(state.deliveries.length, 1);
    assert.equal(state.deliveries[0]?.deliverAt, '2026-09-13T04:00:00.000Z');

    const serialised = JSON.stringify(state.deliveries[0]?.payload);
    assert.equal(serialised.includes('Syntheticol'), false, serialised);
    assert.equal(serialised.includes('boxes'), false, serialised);
    assert.equal(serialised.includes('Nile'), false, serialised);
  });
});

describe('alert episode coalescing', () => {
  it('opens one episode and schedules one delivery for the first signal', () => {
    const result = applyAlertSignal(emptyAlertState(), signal(), policy);
    assert.equal(result.kind, 'opened');
    assert.equal(result.kind === 'opened' ? result.delivery.deliverAt : '', '2026-09-13T04:00:00.000Z');
  });

  it('coalesces a repeat into the open episode without a second push', () => {
    const first = openedState(emptyAlertState(), signal());
    const result = applyAlertSignal(first, signal({ signalId: 'sig-2', observedAt: '2026-09-12T20:45:00Z' }), policy);

    assert.equal(result.kind, 'coalesced');
    assert.equal(result.state.deliveries.length, 1);
    assert.equal(Object.values(result.state.episodes)[0]?.lastSignalAt, '2026-09-12T20:45:00Z');
  });

  it('treats a replayed signal identity as a duplicate and changes nothing', () => {
    const first = openedState(emptyAlertState(), signal());
    const result = applyAlertSignal(first, signal(), policy);

    assert.equal(result.kind, 'duplicate');
    assert.deepEqual(result.state, first);
  });

  it('refuses a reused signal identity carrying different content', () => {
    const first = openedState(emptyAlertState(), signal());
    const result = applyAlertSignal(first, signal({ subject: 'Something else' }), policy);

    assert.equal(result.kind, 'rejected');
    assert.equal(result.kind === 'rejected' ? result.reason : '', 'conflicting_signal');
  });

  it('keeps separate episodes per condition and per installation', () => {
    let state = openedState(emptyAlertState(), signal());
    state = openedState(state, signal({ signalId: 'sig-2', conditionKey: 'shortage:pack-20' }));
    state = openedState(state, signal({ signalId: 'sig-3', installationId: 'inst-branch-02' }));

    assert.equal(Object.keys(state.episodes).length, 3);
    assert.equal(state.deliveries.length, 3);
  });

  it('raises episode severity on escalation without pushing again', () => {
    const first = openedState(emptyAlertState(), signal());
    const result = applyAlertSignal(first, signal({ signalId: 'sig-2', severity: 'critical' }), policy);

    assert.equal(result.kind, 'coalesced');
    assert.equal(Object.values(result.state.episodes)[0]?.severity, 'critical');
    assert.equal(result.state.deliveries.length, 1);
  });
});

describe('alert episode lifecycle and policy', () => {
  it('opens a new episode and a new delivery after the condition resolves', () => {
    const first = openedState(emptyAlertState(), signal());
    const resolved = resolveAlertCondition(first, 'inst-branch-01', 'shortage:pack-10', '2026-09-12T21:00:00Z');
    assert.equal(Object.values(resolved.episodes)[0]?.status, 'resolved');

    const reopened = applyAlertSignal(resolved, signal({ signalId: 'sig-9', observedAt: '2026-09-12T22:00:00Z' }), policy);
    assert.equal(reopened.kind, 'opened');
    assert.equal(reopened.state.deliveries.length, 2);
    assert.equal(Object.keys(reopened.state.episodes).length, 1);
  });

  it('leaves an unknown condition untouched when resolving', () => {
    const first = openedState(emptyAlertState(), signal());
    assert.deepEqual(resolveAlertCondition(first, 'inst-branch-01', 'shortage:absent', '2026-09-12T21:00:00Z'), first);
  });

  it('delivers an overriding severity immediately through the quiet window', () => {
    const result = applyAlertSignal(emptyAlertState(), signal({ severity: 'critical' }), policy);
    assert.equal(result.kind, 'opened');
    assert.equal(result.kind === 'opened' ? result.delivery.deliverAt : '', '2026-09-12T20:30:00.000Z');
  });

  it('records the episode even when the policy permits no delivery window', () => {
    const silent: AlertPolicy = {
      quietHours: { timeZone: 'Africa/Cairo', startMinute: 0, endMinute: 1440 },
      bypassSeverities: [],
    };
    const result = applyAlertSignal(emptyAlertState(), signal(), silent);

    assert.equal(result.kind, 'opened_without_delivery');
    assert.equal(result.kind === 'opened_without_delivery' ? result.reason : '', 'no_window_found');
    assert.equal(Object.keys(result.state.episodes).length, 1);
    assert.equal(result.state.deliveries.length, 0);
  });

  it('refuses a signal that cannot identify or time itself', () => {
    const rejection = (override: Partial<AlertSignal>): string => {
      const result = applyAlertSignal(emptyAlertState(), signal(override), policy);
      assert.equal(result.kind, 'rejected');
      return result.kind === 'rejected' ? result.reason : '';
    };

    assert.equal(rejection({ signalId: '' }), 'invalid_signal');
    assert.equal(rejection({ installationId: '' }), 'invalid_signal');
    assert.equal(rejection({ conditionKey: '' }), 'invalid_signal');
    assert.equal(rejection({ observedAt: 'not-a-time' }), 'invalid_signal');
  });
});
