import type { AlertPolicy, AlertSeverity } from '../../alerting/src/alert-episode.ts';

/**
 * Stored notification configuration for one branch, read from the database and joined with the
 * branch time zone. Nothing here is derived from the machine running the process: the time zone is
 * the branch's own, and the window is explicit configuration rather than a built-in default.
 */
export type NotificationPolicyRecord = Readonly<{
  status: string;
  /** IANA zone of the branch the installation belongs to. */
  timeZone: string;
  /** A window is only observed when the row says so; it is never inferred from the minutes. */
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  bypassSeverities: readonly string[];
}>;

export type PolicyRefusalReason =
  | 'policy_missing'
  | 'policy_inactive'
  | 'invalid_time_zone'
  | 'invalid_quiet_window'
  | 'invalid_bypass_severity';

export type PolicyResolution =
  | Readonly<{ kind: 'resolved'; policy: AlertPolicy }>
  | Readonly<{ kind: 'refused'; reason: PolicyRefusalReason }>;

const MINUTES_PER_DAY = 1440;
const MAX_TIME_ZONE_LENGTH = 64;
const severities: readonly AlertSeverity[] = ['informational', 'actionable', 'critical'];

/**
 * A zone name starts with a letter and is made of name segments. The leading-letter rule is what
 * rejects a fixed offset such as `+02:00`: an offset cannot express a daylight saving change, so a
 * window stored against one would drift by an hour twice a year. The character class also rejects
 * relative path fragments, which keeps a stored value from being mistaken for a file reference.
 */
const timeZonePattern = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

function usableTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > MAX_TIME_ZONE_LENGTH) return false;
  if (!timeZonePattern.test(timeZone)) return false;
  try {
    // The platform's own zone database is the authority; an unknown name throws here.
    return new Intl.DateTimeFormat('en-GB', { timeZone }).resolvedOptions().timeZone !== undefined;
  } catch {
    return false;
  }
}

function usableMinute(minute: number): boolean {
  return Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY;
}

function refused(reason: PolicyRefusalReason): PolicyResolution {
  // A refusal deliberately carries no policy field. There is nothing a caller could read from it and
  // mistake for permission to deliver.
  return Object.freeze({ kind: 'refused', reason });
}

/**
 * Turns a stored row into the scheduler's policy, or refuses it.
 *
 * Every refusal path exists because its absence would mean the same thing to the scheduler as "no
 * quiet hours here", and that reading turns a missing row, a typo in a zone name or a half-written
 * migration into a push in the middle of the night. There is no default policy and no fallback zone.
 */
export function resolveNotificationPolicy(record: NotificationPolicyRecord | null | undefined): PolicyResolution {
  if (record === null || record === undefined) return refused('policy_missing');
  if (record.status !== 'active') return refused('policy_inactive');
  if (!usableTimeZone(record.timeZone)) return refused('invalid_time_zone');
  if (!usableMinute(record.quietStartMinute) || !usableMinute(record.quietEndMinute)) {
    return refused('invalid_quiet_window');
  }
  if (typeof record.quietHoursEnabled !== 'boolean') return refused('invalid_quiet_window');
  // Equal ends mean "never quiet" to the scheduler. Accepting them from an enabled row would let a
  // zeroed or half-migrated record read as a deliberate decision to observe no window at all.
  if (record.quietHoursEnabled && record.quietStartMinute === record.quietEndMinute) {
    return refused('invalid_quiet_window');
  }
  if (!Array.isArray(record.bypassSeverities)
    || record.bypassSeverities.length > severities.length
    || record.bypassSeverities.some((severity) => !severities.includes(severity as AlertSeverity))) {
    return refused('invalid_bypass_severity');
  }

  const window = record.quietHoursEnabled
    ? { startMinute: record.quietStartMinute, endMinute: record.quietEndMinute }
    // An explicitly disabled window is expressed as the scheduler's own "never quiet" encoding. It is
    // reachable only from a row that says quietHoursEnabled, never from an unusable one.
    : { startMinute: 0, endMinute: 0 };

  return Object.freeze({
    kind: 'resolved',
    policy: Object.freeze({
      quietHours: Object.freeze({ timeZone: record.timeZone, ...window }),
      bypassSeverities: Object.freeze([...record.bypassSeverities] as AlertSeverity[]),
    }),
  });
}
