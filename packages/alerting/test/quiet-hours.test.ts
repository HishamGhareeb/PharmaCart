import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isWithinQuietHours,
  scheduleDelivery,
  type QuietHoursPolicy,
} from '../src/quiet-hours.ts';

const cairoNight: QuietHoursPolicy = {
  timeZone: 'Africa/Cairo',
  startMinute: 22 * 60,
  endMinute: 7 * 60,
};

function deliverAt(policy: QuietHoursPolicy, instant: string, bypass = false): string {
  const window = scheduleDelivery(policy, instant, bypass);
  assert.notEqual(window.kind, 'rejected', window.kind === 'rejected' ? window.reason : '');
  return window.kind === 'rejected' ? '' : window.deliverAt;
}

describe('quiet hours scheduling', () => {
  it('delivers immediately outside the quiet window', () => {
    const window = scheduleDelivery(cairoNight, '2026-09-12T12:00:00Z', false);
    assert.equal(window.kind, 'immediate');
    assert.equal(window.kind === 'immediate' ? window.deliverAt : '', '2026-09-12T12:00:00.000Z');
  });

  it('defers to the end of a window that crosses midnight', () => {
    assert.equal(deliverAt(cairoNight, '2026-09-12T20:30:00Z'), '2026-09-13T04:00:00.000Z');
    assert.equal(deliverAt(cairoNight, '2026-09-13T01:00:00Z'), '2026-09-13T04:00:00.000Z');
  });

  it('defers to the end of a window inside a single day', () => {
    const siesta: QuietHoursPolicy = { timeZone: 'Africa/Cairo', startMinute: 13 * 60, endMinute: 14 * 60 };
    assert.equal(deliverAt(siesta, '2026-09-12T10:30:00Z'), '2026-09-12T11:00:00.000Z');
  });

  it('follows the local offset rather than a fixed one', () => {
    assert.equal(isWithinQuietHours(cairoNight, '2026-09-12T20:30:00Z'), true);
    assert.equal(isWithinQuietHours(cairoNight, '2026-01-15T20:30:00Z'), true);
    assert.equal(isWithinQuietHours(cairoNight, '2026-01-15T19:30:00Z'), false);
  });

  it('skips a local time that daylight saving removes from the calendar', () => {
    const gap: QuietHoursPolicy = {
      timeZone: 'America/New_York',
      startMinute: 60,
      endMinute: 150,
    };
    assert.equal(isWithinQuietHours(gap, '2026-03-08T06:30:00Z'), true);
    assert.equal(deliverAt(gap, '2026-03-08T06:30:00Z'), '2026-03-08T07:00:00.000Z');
  });

  it('always defers to an instant that is itself outside the window', () => {
    for (const instant of [
      '2026-09-12T20:30:00Z',
      '2026-09-13T01:00:00Z',
      '2026-01-15T22:30:00Z',
      '2026-03-08T06:30:00Z',
    ]) {
      const policy = instant.startsWith('2026-03-08')
        ? { timeZone: 'America/New_York', startMinute: 60, endMinute: 150 }
        : cairoNight;
      assert.equal(isWithinQuietHours(policy, deliverAt(policy, instant)), false, instant);
    }
  });

  it('lets an overriding severity through the window without rescheduling', () => {
    const window = scheduleDelivery(cairoNight, '2026-09-12T20:30:00Z', true);
    assert.equal(window.kind, 'immediate');
    assert.equal(window.kind === 'immediate' ? window.deliverAt : '', '2026-09-12T20:30:00.000Z');
  });

  it('treats an empty window as no quiet hours at all', () => {
    const none: QuietHoursPolicy = { timeZone: 'Africa/Cairo', startMinute: 0, endMinute: 0 };
    assert.equal(isWithinQuietHours(none, '2026-09-12T20:30:00Z'), false);
    assert.equal(deliverAt(none, '2026-09-12T20:30:00Z'), '2026-09-12T20:30:00.000Z');
  });

  it('reports a whole-day quiet policy rather than delivering anyway', () => {
    const silent: QuietHoursPolicy = { timeZone: 'Africa/Cairo', startMinute: 0, endMinute: 1440 };
    const window = scheduleDelivery(silent, '2026-09-12T20:30:00Z', false);
    assert.equal(window.kind, 'rejected');
    assert.equal(window.kind === 'rejected' ? window.reason : '', 'no_window_found');
  });

  it('refuses an unusable policy or instant instead of guessing a local time', () => {
    const rejection = (policy: QuietHoursPolicy, instant: string): string => {
      const window = scheduleDelivery(policy, instant, false);
      assert.equal(window.kind, 'rejected');
      return window.kind === 'rejected' ? window.reason : '';
    };

    assert.equal(rejection({ ...cairoNight, timeZone: 'Mars/Olympus' }, '2026-09-12T12:00:00Z'), 'invalid_time_zone');
    assert.equal(rejection({ ...cairoNight, startMinute: -1 }, '2026-09-12T12:00:00Z'), 'invalid_window');
    assert.equal(rejection({ ...cairoNight, endMinute: 1441 }, '2026-09-12T12:00:00Z'), 'invalid_window');
    assert.equal(rejection({ ...cairoNight, startMinute: 10.5 }, '2026-09-12T12:00:00Z'), 'invalid_window');
    assert.equal(rejection(cairoNight, 'not-a-time'), 'invalid_instant');
  });
});
