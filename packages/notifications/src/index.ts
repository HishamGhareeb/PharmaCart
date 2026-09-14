/**
 * Synthetic alert delivery: policy resolution, acceptance and dispatch planning, payload sealing and
 * the file-backed development sink. Persistence lives in `packages/db/src/notifications.ts`; nothing
 * in this package opens a database connection or reaches a network.
 */
export { isStrictInstant, strictInstantMs } from './instant.ts';
export {
  resolveNotificationPolicy,
  type NotificationPolicyRecord,
  type PolicyRefusalReason,
  type PolicyResolution,
} from './policy.ts';
export {
  inspectDeliveryPayload,
  sealDeliveryPayload,
  UnsafePayloadError,
  REDACTED_BODY,
  REDACTED_TITLES,
  type DeliveryPayloadDraft,
  type PayloadViolation,
  type SafeDeliveryPayload,
} from './payload.ts';
export {
  alertSignalFingerprint,
  classifySignalIdentity,
  planAlertAcceptance,
  planDeliveryAttempt,
  planEpisodeResolution,
  validateAlertSignal,
  MAX_DELIVERY_DEFERRALS,
  MAX_OPEN_EPISODES_PER_INSTALLATION,
  MAX_SIGNAL_AGE_MS,
  MAX_SIGNAL_SKEW_MS,
  type AcceptanceContext,
  type AcceptancePlan,
  type DeliveryAttemptPlan,
  type EpisodeResolutionPlan,
  type PlannedDelivery,
  type SignalRefusalReason,
  type SignalValidation,
} from './acceptance.ts';
export {
  callWithin,
  planPreSendLookup,
  planReconciliation,
  reconciliationEligibility,
  resolveDispatcherOptions,
  resolveLockTimeoutMs,
  MAX_LOOKUP_FAILURES,
  type BoundedResult,
  type DispatcherOptions,
  type LookupResult,
  type PreSendPlan,
  type ReconciliationEligibility,
  type ReconciliationPlan,
  type ResolvedDispatcherOptions,
} from './dispatch.ts';
export {
  DeliverySinkLockError,
  DeliverySinkRefusedError,
  DeliverySinkTimeoutError,
  DeliverySinkUnavailableError,
  SyntheticFileDeliverySink,
  type DeliveryReceipt,
  type DeliverySink,
  type SinkLedger,
  type SinkViolation,
  type SyntheticSinkMode,
  type SyntheticSinkOptions,
} from './sink.ts';
