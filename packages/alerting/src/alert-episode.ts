import {
  scheduleDelivery,
  type QuietHoursPolicy,
  type QuietHoursRejectionReason,
} from './quiet-hours.ts';

export type AlertSeverity = 'informational' | 'actionable' | 'critical';

export type AlertSignal = Readonly<{
  signalId: string;
  installationId: string;
  conditionKey: string;
  severity: AlertSeverity;
  observedAt: string;
  subject: string;
  detail: string;
}>;

export type AlertPolicy = Readonly<{
  quietHours: QuietHoursPolicy;
  bypassSeverities: readonly AlertSeverity[];
}>;

export type AlertEpisode = Readonly<{
  episodeId: string;
  installationId: string;
  conditionKey: string;
  severity: AlertSeverity;
  openedAt: string;
  lastSignalAt: string;
  signalCount: number;
  status: 'open' | 'resolved';
}>;

export type DeliveryPayload = Readonly<{
  episodeId: string;
  installationId: string;
  title: string;
  body: string;
}>;

export type ScheduledDelivery = Readonly<{
  episodeId: string;
  deliverAt: string;
  deferred: boolean;
  payload: DeliveryPayload;
}>;

export type AlertState = Readonly<{
  episodes: Readonly<Record<string, AlertEpisode>>;
  signalFingerprints: Readonly<Record<string, string>>;
  deliveries: readonly ScheduledDelivery[];
  episodeSequence: number;
}>;

export type ApplyAlertResult =
  | Readonly<{ kind: 'opened'; state: AlertState; delivery: ScheduledDelivery }>
  | Readonly<{ kind: 'opened_without_delivery'; state: AlertState; reason: QuietHoursRejectionReason }>
  | Readonly<{ kind: 'coalesced'; state: AlertState }>
  | Readonly<{ kind: 'duplicate'; state: AlertState }>
  | Readonly<{ kind: 'rejected'; reason: 'invalid_signal' | 'conflicting_signal'; state: AlertState }>;

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  informational: 0,
  actionable: 1,
  critical: 2,
};

const SEVERITY_TITLE: Readonly<Record<AlertSeverity, string>> = {
  informational: 'Stock update',
  actionable: 'Stock needs attention',
  critical: 'Urgent stock issue',
};

export function emptyAlertState(): AlertState {
  return {
    episodes: Object.freeze({}),
    signalFingerprints: Object.freeze({}),
    deliveries: Object.freeze([]),
    episodeSequence: 0,
  };
}

export function applyAlertSignal(
  state: AlertState,
  signal: AlertSignal,
  policy: AlertPolicy,
): ApplyAlertResult {
  if (!validSignal(signal)) {
    return { kind: 'rejected', reason: 'invalid_signal', state };
  }

  const signalKey = compositeKey(signal.installationId, signal.signalId);
  const fingerprint = signalFingerprint(signal);
  const priorFingerprint = own(state.signalFingerprints, signalKey);
  if (priorFingerprint !== undefined) {
    return priorFingerprint === fingerprint
      ? { kind: 'duplicate', state }
      : { kind: 'rejected', reason: 'conflicting_signal', state };
  }

  const episodeKey = compositeKey(signal.installationId, signal.conditionKey);
  const current = own(state.episodes, episodeKey);
  const fingerprints = Object.freeze({ ...state.signalFingerprints, [signalKey]: fingerprint });

  if (current !== undefined && current.status === 'open') {
    const coalesced: AlertEpisode = {
      ...current,
      severity: higherSeverity(current.severity, signal.severity),
      lastSignalAt: signal.observedAt,
      signalCount: current.signalCount + 1,
    };
    return {
      kind: 'coalesced',
      state: Object.freeze({
        ...state,
        signalFingerprints: fingerprints,
        episodes: Object.freeze({ ...state.episodes, [episodeKey]: Object.freeze(coalesced) }),
      }),
    };
  }

  const episodeSequence = state.episodeSequence + 1;
  const episode: AlertEpisode = Object.freeze({
    episodeId: `ep-${episodeSequence}`,
    installationId: signal.installationId,
    conditionKey: signal.conditionKey,
    severity: signal.severity,
    openedAt: signal.observedAt,
    lastSignalAt: signal.observedAt,
    signalCount: 1,
    status: 'open',
  });

  const openedState: AlertState = {
    ...state,
    signalFingerprints: fingerprints,
    episodes: Object.freeze({ ...state.episodes, [episodeKey]: episode }),
    episodeSequence,
  };

  const bypass = policy.bypassSeverities.includes(signal.severity);
  const window = scheduleDelivery(policy.quietHours, signal.observedAt, bypass);
  if (window.kind === 'rejected') {
    return {
      kind: 'opened_without_delivery',
      state: Object.freeze(openedState),
      reason: window.reason,
    };
  }

  const delivery: ScheduledDelivery = Object.freeze({
    episodeId: episode.episodeId,
    deliverAt: window.deliverAt,
    deferred: window.kind === 'deferred',
    payload: redactedPayload(episode),
  });

  return {
    kind: 'opened',
    state: Object.freeze({
      ...openedState,
      deliveries: Object.freeze([...state.deliveries, delivery]),
    }),
    delivery,
  };
}

export function resolveAlertCondition(
  state: AlertState,
  installationId: string,
  conditionKey: string,
  resolvedAt: string,
): AlertState {
  const episodeKey = compositeKey(installationId, conditionKey);
  const current = own(state.episodes, episodeKey);
  if (current === undefined || current.status === 'resolved') {
    return state;
  }

  return Object.freeze({
    ...state,
    episodes: Object.freeze({
      ...state.episodes,
      [episodeKey]: Object.freeze({ ...current, status: 'resolved', lastSignalAt: resolvedAt }),
    }),
  });
}

function redactedPayload(episode: AlertEpisode): DeliveryPayload {
  return Object.freeze({
    episodeId: episode.episodeId,
    installationId: episode.installationId,
    title: SEVERITY_TITLE[episode.severity],
    body: 'Open PharmaCart to review this alert.',
  });
}

function validSignal(signal: AlertSignal): boolean {
  return nonempty(signal.signalId)
    && nonempty(signal.installationId)
    && nonempty(signal.conditionKey)
    && Object.hasOwn(SEVERITY_RANK, signal.severity)
    && !Number.isNaN(new Date(signal.observedAt).getTime());
}

function higherSeverity(left: AlertSeverity, right: AlertSeverity): AlertSeverity {
  return SEVERITY_RANK[right] > SEVERITY_RANK[left] ? right : left;
}

function signalFingerprint(signal: AlertSignal): string {
  return JSON.stringify([
    signal.installationId,
    signal.conditionKey,
    signal.severity,
    signal.observedAt,
    signal.subject,
    signal.detail,
  ]);
}

function compositeKey(installationId: string, value: string): string {
  return `${installationId}\u0000${value}`;
}

function nonempty(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.includes('\u0000');
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
