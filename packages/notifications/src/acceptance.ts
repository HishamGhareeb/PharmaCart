import { createHash } from 'node:crypto';

import {
  applyAlertSignal,
  resolveAlertCondition,
  type AlertEpisode,
  type AlertPolicy,
  type AlertSeverity,
  type AlertSignal,
  type AlertState,
} from '../../alerting/src/alert-episode.ts';
import { scheduleDelivery, type QuietHoursRejectionReason } from '../../alerting/src/quiet-hours.ts';
import { strictInstantMs } from './instant.ts';
import type { PolicyRefusalReason, PolicyResolution } from './policy.ts';

/**
 * Everything the repository decides before it writes a row, as pure functions over arguments.
 *
 * The reducer in `packages/alerting` keeps episodes, signal identity and scheduled deliveries in one
 * in-memory state. None of that is persisted as a document here. The database owns identity (a
 * primary key on the signal), coalescing (a unique index on one open episode per condition) and
 * delivery (a unique outbox row per episode). The repository reads just what one decision needs -
 * the open episode for this condition, if any, and the installation's episode sequence - under a
 * per-installation lock, and the reducer decides over that.
 */
export type AcceptanceContext = Readonly<{
  /** The open episode for this signal's installation and condition key, or null. */
  openEpisode: AlertEpisode | null;
  /** The last episode sequence minted for the installation. */
  episodeSequence: number;
  /** How many episodes are currently open for the installation. */
  openEpisodeCount: number;
}>;

export type SignalRefusalReason =
  | 'invalid_identifier'
  | 'invalid_severity'
  | 'signal_too_large'
  | 'invalid_instant'
  | 'stale_signal'
  | 'future_signal';

export type SignalValidation =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'invalid'; reason: SignalRefusalReason }>;

export type PlannedDelivery = Readonly<{ deliverAt: string; deferred: boolean; title: string; body: string }>;

export type AcceptancePlan =
  | Readonly<{ kind: 'opened'; episodeSequence: number; episode: AlertEpisode; delivery: PlannedDelivery }>
  | Readonly<{
    kind: 'opened_without_delivery'; episodeSequence: number; episode: AlertEpisode;
    reason: QuietHoursRejectionReason | PolicyRefusalReason;
  }>
  | Readonly<{ kind: 'coalesced'; episodeSequence: number; episode: AlertEpisode }>
  | Readonly<{ kind: 'refused'; reason: SignalRefusalReason | 'episode_capacity_exceeded' | 'invalid_episode_context' }>;

export type EpisodeResolutionPlan =
  | Readonly<{ kind: 'resolved'; episode: AlertEpisode }>
  | Readonly<{ kind: 'not_open' }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_instant' }>;

export type DeliveryAttemptPlan =
  | Readonly<{ kind: 'wait' }>
  | Readonly<{ kind: 'send' }>
  | Readonly<{ kind: 'defer'; deliverAt: string }>
  | Readonly<{
    kind: 'hold';
    reason: QuietHoursRejectionReason | PolicyRefusalReason | 'invalid_instant' | 'invalid_deferral_count' | 'defer_limit_exceeded';
  }>;

export const MAX_SIGNAL_ID_LENGTH = 128;
export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_SUBJECT_LENGTH = 256;
export const MAX_DETAIL_LENGTH = 2048;
/** A month-old shortage is a report, not something to wake a pharmacist for. */
export const MAX_SIGNAL_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Two synthetic clocks never agree exactly; more than this is a wrong clock, not skew. */
export const MAX_SIGNAL_SKEW_MS = 5 * 60 * 1000;
/**
 * Open episodes per installation. Resolved episodes do not count: they are history, and counting
 * them would eventually refuse every new condition for the rest of an installation's life.
 */
export const MAX_OPEN_EPISODES_PER_INSTALLATION = 2000;
/** Repeated deferral of the same delivery means the policy is wrong, not that the night is long. */
export const MAX_DELIVERY_DEFERRALS = 8;

const severities: readonly AlertSeverity[] = ['informational', 'actionable', 'critical'];
const nonPrintable = /\p{C}/u;

/**
 * A quiet-hours policy that cannot resolve. It is what the planner hands to the reducer when the
 * stored policy was refused, so the composed scheduler itself declines to schedule: no branch of
 * this module can turn unusable configuration into a delivery, even by mistake.
 */
const unusablePolicy: AlertPolicy = Object.freeze({
  quietHours: Object.freeze({ timeZone: 'Invalid/Unresolvable', startMinute: 0, endMinute: 0 }),
  bypassSeverities: Object.freeze([]),
});

const instantMs = strictInstantMs;

function usableIdentifier(value: string, maximum: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !nonPrintable.test(value);
}

function usableText(value: string, maximum: number): boolean {
  return typeof value === 'string' && value.length <= maximum;
}

/** Matches the composite key the reducer uses internally, so both see one episode per condition. */
function episodeKeyOf(installationId: string, conditionKey: string): string {
  return `${installationId}${String.fromCharCode(0)}${conditionKey}`;
}

/**
 * Bounds the reducer does not impose. `applyAlertSignal` bounds its identifiers but accepts any
 * subject and detail and anything `Date` can parse, which is enough for a pure reducer and not
 * enough for an entry point reached by an at-least-once queue.
 */
export function validateAlertSignal(signal: AlertSignal, now: string): SignalValidation {
  const reference = instantMs(now);
  if (reference === null) return Object.freeze({ kind: 'invalid', reason: 'invalid_instant' });
  if (!usableIdentifier(signal.signalId, MAX_SIGNAL_ID_LENGTH)
    || !usableIdentifier(signal.installationId, MAX_IDENTIFIER_LENGTH)
    || !usableIdentifier(signal.conditionKey, MAX_IDENTIFIER_LENGTH)) {
    return Object.freeze({ kind: 'invalid', reason: 'invalid_identifier' });
  }
  if (!severities.includes(signal.severity)) return Object.freeze({ kind: 'invalid', reason: 'invalid_severity' });
  if (!usableText(signal.subject, MAX_SUBJECT_LENGTH) || !usableText(signal.detail, MAX_DETAIL_LENGTH)) {
    return Object.freeze({ kind: 'invalid', reason: 'signal_too_large' });
  }
  const observed = instantMs(signal.observedAt);
  if (observed === null) return Object.freeze({ kind: 'invalid', reason: 'invalid_instant' });
  if (observed - reference > MAX_SIGNAL_SKEW_MS) return Object.freeze({ kind: 'invalid', reason: 'future_signal' });
  if (reference - observed > MAX_SIGNAL_AGE_MS) return Object.freeze({ kind: 'invalid', reason: 'stale_signal' });
  return Object.freeze({ kind: 'valid' });
}

/**
 * Content hash of a signal identity. Length prefixes keep the encoding unambiguous, so content
 * moved from one field to the next cannot produce the same fingerprint and read as a replay.
 */
export function alertSignalFingerprint(signal: AlertSignal): string {
  const parts = [
    signal.installationId, signal.signalId, signal.conditionKey,
    signal.severity, signal.observedAt, signal.subject, signal.detail,
  ].map((part) => (typeof part === 'string' ? part : String(part)));
  const encoded = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/**
 * A replay carrying identical content changes nothing. The same identity carrying different content
 * is an upstream defect, not a retry, and is refused rather than silently overwriting the first.
 */
export function classifySignalIdentity(
  storedFingerprint: string | null,
  signal: AlertSignal,
): 'new' | 'duplicate' | 'conflicting' {
  if (storedFingerprint === null || storedFingerprint === undefined) return 'new';
  return storedFingerprint === alertSignalFingerprint(signal) ? 'duplicate' : 'conflicting';
}

function usableContext(context: AcceptanceContext): boolean {
  return Number.isSafeInteger(context.episodeSequence) && context.episodeSequence >= 0
    && Number.isSafeInteger(context.openEpisodeCount) && context.openEpisodeCount >= 0;
}

export function planAlertAcceptance(
  context: AcceptanceContext,
  signal: AlertSignal,
  resolution: PolicyResolution,
  now: string,
): AcceptancePlan {
  const validation = validateAlertSignal(signal, now);
  if (validation.kind === 'invalid') return Object.freeze({ kind: 'refused', reason: validation.reason });
  if (!usableContext(context)) return Object.freeze({ kind: 'refused', reason: 'invalid_episode_context' });

  const current = context.openEpisode;
  if (current !== null && (current.status !== 'open'
    || current.installationId !== signal.installationId || current.conditionKey !== signal.conditionKey)) {
    // The repository read the wrong row. Coalescing into it would merge two conditions' history.
    throw new Error('Alert planning context does not match the signal condition');
  }
  // A condition already open keeps coalescing, so reaching the bound never blocks what is tracked.
  if (current === null && context.openEpisodeCount >= MAX_OPEN_EPISODES_PER_INSTALLATION) {
    return Object.freeze({ kind: 'refused', reason: 'episode_capacity_exceeded' });
  }

  const episodeKey = episodeKeyOf(signal.installationId, signal.conditionKey);
  const usable = resolution.kind === 'resolved';
  const reduced: AlertState = {
    episodes: current === null ? Object.freeze({}) : Object.freeze({ [episodeKey]: current }),
    // Identity is the database's job here; an empty map keeps this call a pure episode decision.
    signalFingerprints: Object.freeze({}),
    deliveries: Object.freeze([]),
    episodeSequence: context.episodeSequence,
  };
  const result = applyAlertSignal(reduced, signal, usable ? resolution.policy : unusablePolicy);

  if (result.kind === 'duplicate' || result.kind === 'rejected') {
    // Unreachable: identity was not offered to the reducer, and validation above is strictly
    // stronger than the reducer's own. Reaching it means one of those two facts changed.
    throw new Error(`Alert planning reached an unexpected reducer outcome: ${result.kind}`);
  }

  const episode = result.state.episodes[episodeKey]!;
  const episodeSequence = result.state.episodeSequence;

  if (result.kind === 'coalesced') return Object.freeze({ kind: 'coalesced', episodeSequence, episode });
  if (result.kind === 'opened_without_delivery') {
    return Object.freeze({
      kind: 'opened_without_delivery',
      episodeSequence,
      episode,
      // When the policy was refused the reducer's reason only reports the unusable placeholder; the
      // stored refusal is the fact worth recording.
      reason: usable ? result.reason : resolution.reason,
    });
  }
  return Object.freeze({
    kind: 'opened',
    episodeSequence,
    episode,
    delivery: Object.freeze({
      deliverAt: result.delivery.deliverAt,
      deferred: result.delivery.deferred,
      // Only the two redacted strings travel. The episode identifier the reducer minted is a
      // per-installation sequence; the durable opaque identifier is assigned when the row is written.
      title: result.delivery.payload.title,
      body: result.delivery.payload.body,
    }),
  });
}

/**
 * Closes the open episode for a condition through the reducer, so a later signal opens a genuinely
 * new episode with its own delivery. Without a resolution an episode stays open forever and every
 * later shortage of the same product coalesces silently into it.
 */
export function planEpisodeResolution(openEpisode: AlertEpisode | null, resolvedAt: string): EpisodeResolutionPlan {
  if (instantMs(resolvedAt) === null) return Object.freeze({ kind: 'refused', reason: 'invalid_instant' });
  if (openEpisode === null || openEpisode.status !== 'open') return Object.freeze({ kind: 'not_open' });
  const key = episodeKeyOf(openEpisode.installationId, openEpisode.conditionKey);
  const state = resolveAlertCondition({
    episodes: Object.freeze({ [key]: openEpisode }),
    signalFingerprints: Object.freeze({}),
    deliveries: Object.freeze([]),
    episodeSequence: 0,
  }, openEpisode.installationId, openEpisode.conditionKey, resolvedAt);
  return Object.freeze({ kind: 'resolved', episode: state.episodes[key]! });
}

/**
 * Decides what a dispatcher may do with a stored delivery at the instant it is considered.
 *
 * The quiet window is evaluated again here rather than trusted from scheduling time. A delivery
 * scheduled for noon and dispatched at midnight - because a worker was down, a restart was slow, or
 * a lease expired - would otherwise arrive inside the window the policy exists to protect.
 */
export function planDeliveryAttempt(input: Readonly<{
  severity: AlertSeverity;
  deliverAt: string;
  now: string;
  deferrals: number;
  resolution: PolicyResolution;
}>): DeliveryAttemptPlan {
  const nowMs = instantMs(input.now);
  const deliverMs = instantMs(input.deliverAt);
  if (nowMs === null || deliverMs === null) return Object.freeze({ kind: 'hold', reason: 'invalid_instant' });
  if (nowMs < deliverMs) return Object.freeze({ kind: 'wait' });
  if (input.resolution.kind === 'refused') {
    return Object.freeze({ kind: 'hold', reason: input.resolution.reason });
  }
  if (!Number.isInteger(input.deferrals) || input.deferrals < 0) {
    return Object.freeze({ kind: 'hold', reason: 'invalid_deferral_count' });
  }

  const policy = input.resolution.policy;
  if (policy.bypassSeverities.includes(input.severity)) return Object.freeze({ kind: 'send' });

  const window = scheduleDelivery(policy.quietHours, input.now, false);
  if (window.kind === 'rejected') return Object.freeze({ kind: 'hold', reason: window.reason });
  if (window.kind === 'immediate') return Object.freeze({ kind: 'send' });
  if (input.deferrals >= MAX_DELIVERY_DEFERRALS) {
    return Object.freeze({ kind: 'hold', reason: 'defer_limit_exceeded' });
  }
  return Object.freeze({ kind: 'defer', deliverAt: window.deliverAt });
}
