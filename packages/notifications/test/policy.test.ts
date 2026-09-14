import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveNotificationPolicy, type NotificationPolicyRecord } from '../src/policy.ts';
import { scheduleDelivery } from '../../alerting/src/quiet-hours.ts';

// The resolver stands between stored configuration and the pure scheduler. Its only real job is to
// make sure that no unusable configuration can be read as "there is no quiet window", because that
// reading turns a broken row into an immediate push at three in the morning.

const active: NotificationPolicyRecord = {
  status: 'active',
  timeZone: 'Africa/Cairo',
  quietHoursEnabled: true,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  bypassSeverities: ['critical'],
};

/** Quiet-hours instant for Cairo: 23:30 local in September (UTC+3). */
const insideWindow = '2026-09-12T20:30:00Z';

function refusalReason(record: NotificationPolicyRecord | null): string {
  const resolution = resolveNotificationPolicy(record);
  assert.equal(resolution.kind, 'refused', `expected a refusal, received ${resolution.kind}`);
  return resolution.kind === 'refused' ? resolution.reason : '';
}

/**
 * The property under test for every refusal: a refused policy must not be usable to deliver, and
 * must never be silently replaced by a permissive one.
 */
function assertNotImmediatelyDeliverable(record: NotificationPolicyRecord | null): void {
  const resolution = resolveNotificationPolicy(record);
  assert.equal(resolution.kind, 'refused');
  assert.equal('policy' in resolution, false, 'a refused resolution must not carry a usable policy');
}

describe('notification policy resolution', () => {
  it('resolves an active policy into the scheduler policy shape', () => {
    const resolution = resolveNotificationPolicy(active);
    assert.equal(resolution.kind, 'resolved');
    if (resolution.kind !== 'resolved') return;
    assert.deepEqual(resolution.policy.quietHours, {
      timeZone: 'Africa/Cairo',
      startMinute: 1320,
      endMinute: 420,
    });
    assert.deepEqual(resolution.policy.bypassSeverities, ['critical']);
    // The resolved policy really does defer inside the window.
    assert.equal(scheduleDelivery(resolution.policy.quietHours, insideWindow, false).kind, 'deferred');
  });

  it('refuses a missing policy rather than treating absent configuration as no quiet hours', () => {
    assert.equal(refusalReason(null), 'policy_missing');
    assertNotImmediatelyDeliverable(null);
  });

  it('refuses a policy that is not active', () => {
    assert.equal(refusalReason({ ...active, status: 'draft' }), 'policy_inactive');
    assertNotImmediatelyDeliverable({ ...active, status: 'draft' });
  });

  it('refuses an unknown time zone instead of falling back to the server zone', () => {
    assert.equal(refusalReason({ ...active, timeZone: 'Mars/Olympus' }), 'invalid_time_zone');
    assertNotImmediatelyDeliverable({ ...active, timeZone: 'Mars/Olympus' });
  });

  it('refuses an empty, oversized or structurally impossible time zone', () => {
    assert.equal(refusalReason({ ...active, timeZone: '' }), 'invalid_time_zone');
    assert.equal(refusalReason({ ...active, timeZone: 'x'.repeat(65) }), 'invalid_time_zone');
    assert.equal(refusalReason({ ...active, timeZone: '../../etc/localtime' }), 'invalid_time_zone');
  });

  it('refuses a fixed-offset zone because it cannot express a daylight saving change', () => {
    assert.equal(refusalReason({ ...active, timeZone: '+02:00' }), 'invalid_time_zone');
  });

  it('refuses non-integer, negative, infinite and out-of-day quiet minutes', () => {
    for (const minute of [22.5, -1, 1440, 100_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        refusalReason({ ...active, quietStartMinute: minute }),
        'invalid_quiet_window',
        `start minute ${String(minute)} must be refused`,
      );
      assert.equal(
        refusalReason({ ...active, quietEndMinute: minute }),
        'invalid_quiet_window',
        `end minute ${String(minute)} must be refused`,
      );
    }
  });

  it('refuses an enabled window whose ends are equal, which the scheduler reads as never quiet', () => {
    assert.equal(refusalReason({ ...active, quietStartMinute: 0, quietEndMinute: 0 }), 'invalid_quiet_window');
    assertNotImmediatelyDeliverable({ ...active, quietStartMinute: 0, quietEndMinute: 0 });
  });

  it('allows a disabled quiet window only when the record says so explicitly', () => {
    const disabled: NotificationPolicyRecord = {
      ...active, quietHoursEnabled: false, quietStartMinute: 0, quietEndMinute: 0,
    };
    const resolution = resolveNotificationPolicy(disabled);
    assert.equal(resolution.kind, 'resolved');
    if (resolution.kind !== 'resolved') return;
    assert.equal(scheduleDelivery(resolution.policy.quietHours, insideWindow, false).kind, 'immediate');
    // The zone is still validated, so a disabled window cannot be used to smuggle an unusable zone in.
    assert.equal(refusalReason({ ...disabled, timeZone: 'Mars/Olympus' }), 'invalid_time_zone');
  });

  it('refuses an unknown severity in the bypass list', () => {
    assert.equal(refusalReason({ ...active, bypassSeverities: ['urgent'] }), 'invalid_bypass_severity');
    assert.equal(refusalReason({ ...active, bypassSeverities: ['critical', 'urgent'] }), 'invalid_bypass_severity');
  });

  it('refuses a bypass list longer than the severity vocabulary', () => {
    assert.equal(
      refusalReason({ ...active, bypassSeverities: ['critical', 'critical', 'critical', 'critical'] }),
      'invalid_bypass_severity',
    );
  });

  it('returns a frozen policy so a caller cannot widen it after resolution', () => {
    const resolution = resolveNotificationPolicy(active);
    assert.equal(resolution.kind, 'resolved');
    if (resolution.kind !== 'resolved') return;
    assert.equal(Object.isFrozen(resolution.policy), true);
    assert.equal(Object.isFrozen(resolution.policy.quietHours), true);
    assert.equal(Object.isFrozen(resolution.policy.bypassSeverities), true);
  });
});
