export type QuietHoursPolicy = Readonly<{
  timeZone: string;
  startMinute: number;
  endMinute: number;
}>;

export type QuietHoursRejectionReason =
  | 'invalid_time_zone'
  | 'invalid_window'
  | 'invalid_instant'
  | 'no_window_found';

export type DeliveryWindow =
  | Readonly<{ kind: 'immediate'; deliverAt: string }>
  | Readonly<{ kind: 'deferred'; deliverAt: string }>
  | Readonly<{ kind: 'rejected'; reason: QuietHoursRejectionReason }>;

const MINUTES_PER_DAY = 1440;
const SEARCH_LIMIT_MINUTES = 2 * MINUTES_PER_DAY;
const MILLISECONDS_PER_MINUTE = 60_000;

export function scheduleDelivery(
  policy: QuietHoursPolicy,
  instant: string,
  bypass: boolean,
): DeliveryWindow {
  if (!validWindow(policy)) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }

  const observed = new Date(instant);
  if (Number.isNaN(observed.getTime())) {
    return { kind: 'rejected', reason: 'invalid_instant' };
  }

  let localMinuteAt: (moment: Date) => number;
  try {
    localMinuteAt = localMinuteReader(policy.timeZone);
  } catch {
    return { kind: 'rejected', reason: 'invalid_time_zone' };
  }

  if (bypass || !quietAt(policy, localMinuteAt(observed))) {
    return { kind: 'immediate', deliverAt: observed.toISOString() };
  }

  for (let step = 1; step <= SEARCH_LIMIT_MINUTES; step += 1) {
    const candidate = new Date(observed.getTime() + step * MILLISECONDS_PER_MINUTE);
    if (!quietAt(policy, localMinuteAt(candidate))) {
      return { kind: 'deferred', deliverAt: candidate.toISOString() };
    }
  }

  return { kind: 'rejected', reason: 'no_window_found' };
}

export function isWithinQuietHours(policy: QuietHoursPolicy, instant: string): boolean {
  if (!validWindow(policy)) {
    return false;
  }
  const observed = new Date(instant);
  if (Number.isNaN(observed.getTime())) {
    return false;
  }
  try {
    return quietAt(policy, localMinuteReader(policy.timeZone)(observed));
  } catch {
    return false;
  }
}

function quietAt(policy: QuietHoursPolicy, localMinute: number): boolean {
  const { startMinute, endMinute } = policy;
  if (startMinute === endMinute) {
    return false;
  }
  return startMinute < endMinute
    ? localMinute >= startMinute && localMinute < endMinute
    : localMinute >= startMinute || localMinute < endMinute;
}

function localMinuteReader(timeZone: string): (moment: Date) => number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

  return (moment: Date): number => {
    let hour = 0;
    let minute = 0;
    for (const part of formatter.formatToParts(moment)) {
      if (part.type === 'hour') {
        hour = Number(part.value) % 24;
      }
      if (part.type === 'minute') {
        minute = Number(part.value);
      }
    }
    return hour * 60 + minute;
  };
}

function validWindow(policy: QuietHoursPolicy): boolean {
  return Number.isInteger(policy.startMinute)
    && Number.isInteger(policy.endMinute)
    && policy.startMinute >= 0
    && policy.startMinute <= MINUTES_PER_DAY
    && policy.endMinute >= 0
    && policy.endMinute <= MINUTES_PER_DAY;
}
