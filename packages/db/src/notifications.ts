import type { Pool, PoolClient } from 'pg';

import type { AlertEpisode, AlertSeverity, AlertSignal } from '../../alerting/src/alert-episode.ts';
import {
  alertSignalFingerprint, callWithin, classifySignalIdentity, planAlertAcceptance, planDeliveryAttempt,
  planEpisodeResolution, planPreSendLookup, planReconciliation, reconciliationEligibility, resolveDispatcherOptions,
  resolveLockTimeoutMs, resolveNotificationPolicy, sealDeliveryPayload, strictInstantMs, validateAlertSignal,
  type BoundedResult, type DeliveryReceipt, type DeliverySink, type DispatcherOptions, type LookupResult, type NotificationPolicyRecord,
  type PolicyResolution, type ResolvedDispatcherOptions, type SafeDeliveryPayload,
} from '../../notifications/src/index.ts';
import { loadInstallation, refuseInstallation, type InstallationRefusal } from './installation.ts';
import type { Installation } from '../../installation-lifecycle/src/pairing.ts';
import { withTransaction, type RuntimeClient, type TenantContext } from './runtime.ts';

/**
 * Durable alert episodes and their delivery.
 *
 * The decisions live in packages/alerting (episodes, quiet hours, redaction) and
 * packages/notifications (policy resolution, bounds, payload sealing, reconciliation planning, the
 * synthetic sink). This module is the part that has to be right about the database: one transaction
 * per accepted signal, serialised per installation, every lock wait bounded, no sink call while a
 * transaction is open, and every state change guarded by the version it was decided against.
 */

/** Injected everywhere. Nothing in this module reads the server clock. */
export type Clock = () => string;

export class NotificationError extends Error {
  readonly code: string;
  readonly reason: string | null;
  /** Stored status and sync directive behind an INSTALLATION_DENIED; null otherwise. */
  readonly refusal: InstallationRefusal | null;

  constructor(code: string, reason: string | null = null, refusal: InstallationRefusal | null = null) {
    super(reason === null ? code : `${code}: ${reason}`);
    this.name = 'NotificationError';
    this.code = code; this.reason = reason; this.refusal = refusal;
  }
}

/** The installation is taken from the authenticated subject, never from the request body. */
export type IncomingAlertSignal = Omit<AlertSignal, 'installationId'>;

export type InstallationCallOptions = Readonly<{ lockTimeoutMs?: number }>;

export type AcceptanceOutcome = Readonly<{
  outcome: 'opened' | 'coalesced' | 'duplicate' | 'suppressed';
  episodeId: string;
  deliveryId: string | null;
  deliverAt: string | null;
  reason: string | null;
}>;

export type ResolutionOutcome = Readonly<{ outcome: 'resolved' | 'not_open'; episodeId: string | null }>;

export type DispatchStatus =
  | 'delivered' | 'deferred' | 'held' | 'released' | 'outcome_unknown' | 'manual_review' | 'lookup_failed' | 'unchanged';

export type DispatchOutcome = Readonly<{ deliveryId: string; status: DispatchStatus; reason: string | null }>;

/** `leased` rows belong to a live worker; `more` means the batch did not reach every unsettled row. */
export type RecoveryReport = Readonly<{ reconciled: number; unresolved: number; leased: number; more: boolean }>;

export type DispatcherScope = Readonly<{ subject: string; organisationId: string; branchId: string }>;

type StateRow = { episode_sequence: number };
type EpisodeRow = {
  id: string; episode_ref: string; installation_id: string; condition_key: string; severity: AlertSeverity;
  status: 'open' | 'resolved'; opened_at: Date | string; last_signal_at: Date | string; signal_count: number;
};
type PolicyRow = {
  timezone: string; status: string | null; quiet_hours_enabled: boolean | null;
  quiet_start_minute: number | null; quiet_end_minute: number | null; bypass_severities: string[] | null;
};
type OutboxRow = {
  id: string; severity: AlertSeverity; deliver_at: Date | string; status: string; deferrals: number; version: number;
  payload: SafeDeliveryPayload; lease_expires_at: Date | string | null; send_attempted: boolean; lookup_failures: number;
};
type LookupObservation = Readonly<{
  result: LookupResult; outcome: 'found' | 'not_found' | 'failed' | 'timed_out'; receiptId: string | null;
}>;

const LOCK_NOT_AVAILABLE = '55P03';
const UNIQUE_VIOLATION = '23505';
const SETTLING = new Set<DispatchStatus>(['delivered', 'released', 'manual_review']);
const SAFE_REASON = /^[A-Za-z0-9_:-]{1,64}$/;

const OUTBOX_COLUMNS = `o.id,o.severity,o.deliver_at,o.status,o.deferrals,o.version,o.payload,o.lease_expires_at,
  EXISTS(SELECT 1 FROM notification_delivery_attempt a WHERE a.outbox_id=o.id AND a.kind='send') AS send_attempted,
  (SELECT count(*)::int FROM notification_delivery_attempt a
    WHERE a.outbox_id=o.id AND a.kind='lookup' AND a.outcome IN ('failed','timed_out')) AS lookup_failures`;

const EPISODE_COLUMNS = 'id,episode_ref,installation_id,condition_key,severity,status,opened_at,last_signal_at,signal_count';

function instantOf(clock: Clock): string {
  let value: string;
  try { value = clock(); } catch { throw new NotificationError('INVALID_CLOCK', 'clock threw'); }
  if (strictInstantMs(value) === null) throw new NotificationError('INVALID_CLOCK', 'not an instant');
  return value;
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** A lock wait that ran out is a named refusal, not a driver error. */
function translate(error: unknown): unknown {
  return errorCode(error) === LOCK_NOT_AVAILABLE ? new NotificationError('LOCK_TIMEOUT', 'lock_wait_exceeded') : error;
}

async function boundLockWaits(client: RuntimeClient, lockTimeoutMs: number): Promise<void> {
  await client.query("SELECT set_config('lock_timeout',$1,true)", [`${lockTimeoutMs}ms`]);
}

function toEpisode(row: EpisodeRow): AlertEpisode {
  return Object.freeze({
    episodeId: row.episode_ref, installationId: row.installation_id, conditionKey: row.condition_key,
    severity: row.severity, openedAt: isoOf(row.opened_at), lastSignalAt: isoOf(row.last_signal_at),
    signalCount: row.signal_count, status: row.status,
  });
}

/**
 * Reads the branch time zone and the stored policy together. A branch always has a zone; a policy
 * row may be absent, which resolves to a refusal rather than to a permissive default.
 */
async function loadPolicy(client: RuntimeClient, organisationId: string, branchId: string): Promise<PolicyResolution> {
  const result = await client.query<PolicyRow>(
    `SELECT b.timezone, p.status, p.quiet_hours_enabled, p.quiet_start_minute, p.quiet_end_minute, p.bypass_severities
       FROM branch b LEFT JOIN notification_policy p ON p.organisation_id=b.organisation_id AND p.branch_id=b.id
      WHERE b.organisation_id=$1 AND b.id=$2`,
    [organisationId, branchId],
  );
  const row = result.rows[0];
  if (row === undefined || row.status === null) return resolveNotificationPolicy(null);
  const record: NotificationPolicyRecord = {
    status: row.status,
    timeZone: row.timezone,
    quietHoursEnabled: row.quiet_hours_enabled ?? false,
    quietStartMinute: row.quiet_start_minute ?? -1,
    quietEndMinute: row.quiet_end_minute ?? -1,
    bypassSeverities: row.bypass_severities ?? [],
  };
  return resolveNotificationPolicy(record);
}

/**
 * One transaction on behalf of the installation paired to an authenticated subject. Authorisation
 * reads current stored status before any write; the lookup takes a row share lock, so a concurrent
 * revocation cannot commit underneath the work.
 */
async function withInstallation<T>(
  pool: Pool, subject: string, lockTimeoutMs: number,
  action: (client: PoolClient, installation: Installation) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE pharmacart_runtime');
    await boundLockWaits(client, lockTimeoutMs);
    const installation = await loadInstallation(client, subject);
    const refusal = refuseInstallation(installation, 'submit_inventory');
    if (refusal || !installation) throw new NotificationError('INSTALLATION_DENIED', refusal?.reason ?? null, refusal);
    await client.query("SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)",
      [installation.organisationId, installation.branchId]);
    const value = await action(client, installation);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translate(error);
  } finally {
    client.release();
  }
}

/**
 * Takes the installation's serialisation row FOR UPDATE, creating it on first use, and re-checks the
 * lifecycle after the wait: a status change may have committed while this request queued.
 */
async function lockInstallation(client: RuntimeClient, installation: Installation, subject: string): Promise<number> {
  await client.query(
    'INSERT INTO notification_alert_state(installation_id,organisation_id,branch_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [installation.installationId, installation.organisationId, installation.branchId],
  );
  const locked = await client.query<StateRow>(
    'SELECT episode_sequence FROM notification_alert_state WHERE installation_id=$1 FOR UPDATE', [installation.installationId],
  );
  const current = refuseInstallation(await loadInstallation(client, subject), 'submit_inventory');
  if (current) throw new NotificationError('INSTALLATION_DENIED', current.reason, current);
  const row = locked.rows[0];
  if (row === undefined) throw new NotificationError('CORRUPT_ALERT_STATE', 'installation lock row is not visible');
  return row.episode_sequence;
}

async function openEpisodeFor(client: RuntimeClient, installationId: string, conditionKey: string): Promise<EpisodeRow | null> {
  const result = await client.query<EpisodeRow>(
    `SELECT ${EPISODE_COLUMNS} FROM notification_episode
      WHERE installation_id=$1 AND condition_key=$2 AND status='open' FOR UPDATE`,
    [installationId, conditionKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Accepts one alert signal for the installation paired to an authenticated subject.
 *
 * State, signal identity, episode and outbox row commit in this one transaction, so a crash between
 * them is not a state that exists. The per-installation lock serialises acceptance; the unique index
 * on one open episode per condition and the unique outbox row per episode make the outcome a
 * database fact even if that serialisation were ever bypassed.
 */
export async function acceptAlertSignal(
  pool: Pool, subject: string, signal: IncomingAlertSignal, clock: Clock, options: InstallationCallOptions = {},
): Promise<AcceptanceOutcome> {
  const lockTimeoutMs = resolveLockTimeoutMs(options.lockTimeoutMs);
  const now = instantOf(clock);
  return withInstallation(pool, subject, lockTimeoutMs, async (client, installation) => {
    const { installationId, organisationId, branchId } = installation;
    const full: AlertSignal = { ...signal, installationId };
    // Refused before anything is written or queried with caller-supplied identifiers.
    const validation = validateAlertSignal(full, now);
    if (validation.kind === 'invalid') throw new NotificationError('SIGNAL_REFUSED', validation.reason);

    const episodeSequence = await lockInstallation(client, installation, subject);
    const stored = await client.query<{ fingerprint: string; episode_id: string }>(
      'SELECT fingerprint,episode_id FROM notification_signal WHERE installation_id=$1 AND signal_id=$2',
      [installationId, full.signalId],
    );
    const prior = stored.rows[0];
    const identity = classifySignalIdentity(prior?.fingerprint ?? null, full);
    if (identity === 'conflicting') throw new NotificationError('CONFLICTING_SIGNAL', full.signalId);
    if (identity === 'duplicate' && prior !== undefined) {
      return Object.freeze({ outcome: 'duplicate', episodeId: prior.episode_id, deliveryId: null, deliverAt: null, reason: null });
    }

    const open = await openEpisodeFor(client, installationId, full.conditionKey);
    const openCount = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notification_episode WHERE installation_id=$1 AND status='open'", [installationId],
    );
    const plan = planAlertAcceptance(
      { openEpisode: open === null ? null : toEpisode(open), episodeSequence, openEpisodeCount: openCount.rows[0]?.n ?? 0 },
      full, await loadPolicy(client, organisationId, branchId), now,
    );
    if (plan.kind === 'refused') throw new NotificationError('SIGNAL_REFUSED', plan.reason);

    const suppressed = plan.kind === 'opened_without_delivery' ? plan.reason : null;
    const episodeId = plan.kind === 'coalesced'
      ? await coalesceEpisode(client, open, plan.episode)
      : await openEpisode(client, installation, plan.episode, plan.episodeSequence, suppressed);

    await client.query(
      `INSERT INTO notification_signal(installation_id,signal_id,organisation_id,branch_id,fingerprint,episode_id,accepted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [installationId, full.signalId, organisationId, branchId, alertSignalFingerprint(full), episodeId, now],
    );

    if (plan.kind !== 'opened') {
      return Object.freeze({
        outcome: plan.kind === 'coalesced' ? 'coalesced' : 'suppressed', episodeId, deliveryId: null, deliverAt: null, reason: suppressed,
      });
    }
    // Sealed against the allowlist of redacted templates. If a later edit ever routed signal content
    // into the payload, this transaction fails and nothing is scheduled.
    const payload = sealDeliveryPayload({ episodeId, installationId, title: plan.delivery.title, body: plan.delivery.body });
    const outbox = await client.query<{ id: string }>(
      `INSERT INTO notification_outbox(organisation_id,branch_id,installation_id,episode_id,severity,deliver_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [organisationId, branchId, installationId, episodeId, plan.episode.severity, plan.delivery.deliverAt, payload],
    );
    return Object.freeze({
      outcome: 'opened', episodeId, deliveryId: outbox.rows[0]!.id, deliverAt: plan.delivery.deliverAt, reason: null,
    });
  });
}

async function coalesceEpisode(client: RuntimeClient, open: EpisodeRow | null, episode: AlertEpisode): Promise<string> {
  const updated = open === null ? { rowCount: 0 } : await client.query(
    "UPDATE notification_episode SET severity=$2,last_signal_at=$3,signal_count=$4 WHERE id=$1 AND status='open'",
    [open.id, episode.severity, episode.lastSignalAt, episode.signalCount],
  );
  // The planner coalesced into a row this transaction holds locked; anything else is a contradiction
  // to abandon, not to repair.
  if (open === null || updated.rowCount !== 1) throw new NotificationError('EPISODE_NOT_FOUND', episode.episodeId);
  return open.id;
}

async function openEpisode(
  client: RuntimeClient, installation: Installation, episode: AlertEpisode, episodeSequence: number, suppressed: string | null,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO notification_episode(installation_id,organisation_id,branch_id,episode_ref,condition_key,
      severity,status,opened_at,last_signal_at,signal_count,suppressed_reason)
     VALUES($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10) RETURNING id`,
    [installation.installationId, installation.organisationId, installation.branchId, episode.episodeId, episode.conditionKey,
      episode.severity, episode.openedAt, episode.lastSignalAt, episode.signalCount, suppressed],
  );
  await client.query('UPDATE notification_alert_state SET episode_sequence=$2 WHERE installation_id=$1',
    [installation.installationId, episodeSequence]);
  return inserted.rows[0]!.id;
}

/**
 * Closes the open episode for a condition, so the next signal for it opens a new episode with its
 * own delivery. Serialised on the same per-installation lock as acceptance.
 */
export async function resolveAlertEpisode(
  pool: Pool, subject: string, conditionKey: string, clock: Clock, options: InstallationCallOptions = {},
): Promise<ResolutionOutcome> {
  const lockTimeoutMs = resolveLockTimeoutMs(options.lockTimeoutMs);
  const now = instantOf(clock);
  return withInstallation(pool, subject, lockTimeoutMs, async (client, installation) => {
    if (typeof conditionKey !== 'string' || conditionKey === '' || conditionKey.length > 256 || /\p{C}/u.test(conditionKey)) {
      throw new NotificationError('RESOLUTION_REFUSED', 'invalid_identifier');
    }
    await lockInstallation(client, installation, subject);
    const open = await openEpisodeFor(client, installation.installationId, conditionKey);
    const plan = planEpisodeResolution(open === null ? null : toEpisode(open), now);
    if (plan.kind === 'refused') throw new NotificationError('RESOLUTION_REFUSED', plan.reason);
    if (plan.kind === 'not_open' || open === null) return Object.freeze({ outcome: 'not_open', episodeId: null });
    await client.query("UPDATE notification_episode SET status=$2,resolved_at=$3 WHERE id=$1 AND status='open'",
      [open.id, plan.episode.status, now]);
    return Object.freeze({ outcome: 'resolved', episodeId: open.id });
  });
}

function usableReceipt(receipt: DeliveryReceipt | undefined, deliveryId: string): receipt is DeliveryReceipt {
  return typeof receipt === 'object' && receipt !== null && receipt.deliveryId === deliveryId
    && typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0 && receipt.receiptId.length <= 128;
}

function outcome(deliveryId: string, status: DispatchStatus, reason: string | null = null): DispatchOutcome {
  return Object.freeze({ deliveryId, status, reason });
}

async function recordLookup(client: RuntimeClient, outboxId: string, startedAt: string, observed: LookupObservation['outcome']) {
  await client.query(
    `INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at,outcome)
     SELECT id,installation_id,organisation_id,branch_id,'lookup',$2,$3 FROM notification_outbox WHERE id=$1`,
    [outboxId, startedAt, observed],
  );
}

/** A receipt is proof of delivery whatever the row believed; only an already delivered row is left. */
async function settleDelivered(client: RuntimeClient, id: string, receiptId: string, now: string): Promise<DispatchOutcome> {
  const updated = await client.query(
    `UPDATE notification_outbox SET status='delivered',receipt_id=$2,settled_at=$3,version=version+1,lease_expires_at=NULL,last_reason=NULL
      WHERE id=$1 AND status<>'delivered'`, [id, receiptId, now]);
  await client.query("UPDATE notification_delivery_attempt SET outcome='delivered' WHERE outbox_id=$1 AND kind='send' AND outcome IS NULL", [id]);
  return outcome(id, updated.rowCount === 1 ? 'delivered' : 'unchanged');
}

/** Moves a row out of an unsettled state only if nothing moved since it was observed. */
async function guardedTransition(
  client: RuntimeClient, id: string, from: string, version: number, to: 'pending' | 'outcome_unknown' | 'manual_review', reason: string,
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE notification_outbox SET status=$2,last_reason=$3,version=version+1,lease_expires_at=NULL
      WHERE id=$1 AND status=$4 AND version=$5
        AND ($2<>'pending' OR NOT EXISTS(SELECT 1 FROM notification_delivery_attempt a WHERE a.outbox_id=$1 AND a.kind='send'))`,
    [id, to, reason, from, version]);
  if (updated.rowCount === 1 && to !== 'pending') {
    // A send whose owner never recorded an outcome is closed as abandoned, so the evidence says so.
    await client.query("UPDATE notification_delivery_attempt SET outcome='abandoned' WHERE outbox_id=$1 AND kind='send' AND outcome IS NULL", [id]);
  }
  return updated.rowCount === 1;
}

/**
 * Moves due deliveries to a sink.
 *
 * A database transaction is never open while the sink is called, and every sink call has a deadline.
 * Every first send is preceded by a lookup and by a committed send attempt, which a unique index
 * allows once per delivery. A delivery whose outcome is unknown is settled by lookup, escalated to a
 * person, or left alone; it is never sent again.
 */
export class NotificationDispatcher {
  readonly pool: Pool;
  readonly scope: DispatcherScope;
  readonly sink: DeliverySink;
  private readonly clock: Clock;
  private readonly options: ResolvedDispatcherOptions;
  private enabled = false;

  constructor(pool: Pool, scope: DispatcherScope, sink: DeliverySink, clock: Clock, options: DispatcherOptions = {}) {
    if (sink.kind === 'synthetic' && options.allowSyntheticSink !== true) {
      throw new NotificationError('SYNTHETIC_SINK_NOT_ACKNOWLEDGED', 'pass allowSyntheticSink to use a development delivery adapter');
    }
    if (typeof clock !== 'function') throw new NotificationError('INVALID_CLOCK', 'clock is required');
    this.options = resolveDispatcherOptions(options);
    this.pool = pool; this.scope = scope; this.sink = sink; this.clock = clock;
  }

  /** Visible for operators and tests: whether new sends are permitted yet. */
  get dispatchEnabled(): boolean { return this.enabled; }

  private async transaction<T>(callback: (client: RuntimeClient, context: TenantContext) => Promise<T>): Promise<T> {
    try {
      return await withTransaction(this.pool, this.scope.subject, this.scope.organisationId, this.scope.branchId,
        async (client, context) => {
          await boundLockWaits(client, this.options.lockTimeoutMs);
          return callback(client, context);
        });
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Dispatch stays paused until every unsettled delivery has been reconciled against the sink and no
   * live lease remains. A restored database may be older than the sink's own record.
   */
  async recoverAfterRestart(): Promise<RecoveryReport> {
    const { report } = await this.reconcileUnsettled();
    this.enabled = report.unresolved === 0 && report.leased === 0 && !report.more;
    return report;
  }

  /** One bounded pass: reconcile what can be reconciled, then claim and send what is due. */
  async dispatchDue(): Promise<DispatchOutcome[]> {
    if (!this.enabled) return [];
    const { outcomes } = await this.reconcileUnsettled();
    const now = instantOf(this.clock);
    const claimed = await this.claimDue(now);
    const results = [...outcomes, ...claimed.settled];
    for (const claim of claimed.sending) results.push(await this.send(claim.row, claim.version));
    return results;
  }

  private async reconcileUnsettled(): Promise<{ report: RecoveryReport; outcomes: DispatchOutcome[] }> {
    const now = instantOf(this.clock);
    const rows = await this.transaction(async (client) => (await client.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM notification_outbox o WHERE o.status IN ('dispatching','outcome_unknown')
        ORDER BY o.deliver_at, o.id LIMIT $1`, [this.options.batchSize + 1])).rows);
    const outcomes: DispatchOutcome[] = [];
    let reconciled = 0; let unresolved = 0; let leased = 0;
    for (const row of rows.slice(0, this.options.batchSize)) {
      const lease = row.lease_expires_at === null ? null : isoOf(row.lease_expires_at);
      const eligibility = reconciliationEligibility({ status: row.status, leaseExpiresAt: lease }, now);
      if (eligibility.kind === 'ineligible') {
        if (eligibility.reason === 'lease_active') leased += 1; else unresolved += 1;
        continue;
      }
      const result = await this.reconcile(row);
      outcomes.push(result);
      if (SETTLING.has(result.status)) reconciled += 1; else unresolved += 1;
    }
    const report = Object.freeze({ reconciled, unresolved, leased, more: rows.length > this.options.batchSize });
    return { report, outcomes };
  }

  private async lookup(deliveryId: string): Promise<LookupObservation> {
    const call = await callWithin(() => this.sink.lookup(deliveryId), this.options.sinkTimeoutMs);
    if (call.kind === 'timed_out') return Object.freeze({ result: 'failed', outcome: 'timed_out', receiptId: null });
    // An unavailable, refused or nonsensical answer describes this attempt, not the delivery.
    if (call.kind === 'threw' || (call.value !== undefined && !usableReceipt(call.value, deliveryId))) {
      return Object.freeze({ result: 'failed', outcome: 'failed', receiptId: null });
    }
    return call.value === undefined
      ? Object.freeze({ result: 'not_found', outcome: 'not_found', receiptId: null })
      : Object.freeze({ result: 'found', outcome: 'found', receiptId: call.value.receiptId });
  }

  private async reconcile(row: OutboxRow): Promise<DispatchOutcome> {
    const startedAt = instantOf(this.clock);
    const observed = await this.lookup(row.id);
    const status = row.status === 'dispatching' ? 'dispatching' : 'outcome_unknown';
    const plan = planReconciliation(
      { status, sendAttempted: row.send_attempted, lookupFailures: row.lookup_failures }, observed.result,
    );
    return this.transaction(async (client) => {
      await recordLookup(client, row.id, startedAt, observed.outcome);
      switch (plan.kind) {
        case 'settle_delivered':
          return settleDelivered(client, row.id, observed.receiptId!, instantOf(this.clock));
        case 'record_lookup_failure':
          return outcome(row.id, 'lookup_failed', observed.outcome);
        case 'release':
          return outcome(row.id, await guardedTransition(client, row.id, status, row.version, 'pending', plan.reason)
            ? 'released' : 'unchanged', plan.reason);
        case 'mark_unknown':
          return outcome(row.id, await guardedTransition(client, row.id, status, row.version, 'outcome_unknown', plan.reason)
            ? 'outcome_unknown' : 'unchanged', plan.reason);
        case 'manual_review':
          return outcome(row.id, await guardedTransition(client, row.id, status, row.version, 'manual_review', plan.reason)
            ? 'manual_review' : 'unchanged', plan.reason);
      }
    });
  }

  /**
   * Claims due rows and re-evaluates their quiet window in one short transaction. The window is
   * evaluated again here rather than trusted from scheduling time.
   */
  private claimDue(now: string): Promise<{ sending: { row: OutboxRow; version: number }[]; settled: DispatchOutcome[] }> {
    const leaseUntil = new Date(strictInstantMs(now)! + this.options.leaseMs).toISOString();
    return this.transaction(async (client, context) => {
      const resolution = await loadPolicy(client, context.organisationId, context.branchId);
      const due = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM notification_outbox o WHERE o.status='pending' AND o.deliver_at<=$1
          ORDER BY o.deliver_at, o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [now, this.options.batchSize]);
      const sending: { row: OutboxRow; version: number }[] = [];
      const settled: DispatchOutcome[] = [];
      for (const row of due.rows) {
        const plan = planDeliveryAttempt({
          severity: row.severity, deliverAt: isoOf(row.deliver_at), now, deferrals: row.deferrals, resolution,
        });
        if (plan.kind === 'wait') continue;
        if (plan.kind === 'defer') {
          await client.query(`UPDATE notification_outbox SET deliver_at=$2,deferrals=deferrals+1,last_reason='quiet_hours',version=version+1
            WHERE id=$1`, [row.id, plan.deliverAt]);
          settled.push(outcome(row.id, 'deferred', 'quiet_hours'));
        } else if (plan.kind === 'hold') {
          await client.query("UPDATE notification_outbox SET status='held',last_reason=$2,version=version+1 WHERE id=$1", [row.id, plan.reason]);
          settled.push(outcome(row.id, 'held', plan.reason));
        } else {
          const claimed = await client.query<{ version: number }>(
            `UPDATE notification_outbox SET status='dispatching',lease_expires_at=$2,last_reason=NULL,version=version+1
              WHERE id=$1 RETURNING version`, [row.id, leaseUntil]);
          sending.push({ row, version: claimed.rows[0]!.version });
        }
      }
      return { sending, settled };
    });
  }

  /** Called with no transaction open: the sink may be slow, and no row lock waits on it. */
  private async send(row: OutboxRow, claimVersion: number): Promise<DispatchOutcome> {
    const lookupStartedAt = instantOf(this.clock);
    const observed = await this.lookup(row.id);
    const plan = planPreSendLookup(observed.result, row.lookup_failures);
    if (plan.kind !== 'send') {
      return this.transaction(async (client) => {
        await recordLookup(client, row.id, lookupStartedAt, observed.outcome);
        if (plan.kind === 'settle_delivered') return settleDelivered(client, row.id, observed.receiptId!, instantOf(this.clock));
        const to = plan.kind === 'release' ? 'pending' : 'manual_review';
        const moved = await guardedTransition(client, row.id, 'dispatching', claimVersion, to, plan.reason);
        return outcome(row.id, moved ? (plan.kind === 'release' ? 'released' : 'manual_review') : 'unchanged', plan.reason);
      });
    }
    const sendVersion = await this.authoriseSend(row.id, claimVersion, lookupStartedAt);
    if (sendVersion === null) return outcome(row.id, 'unchanged', 'claim_superseded');
    const call = await callWithin(() => this.sink.deliver(row.id, row.payload), this.options.sinkTimeoutMs);
    return this.recordSend(row.id, sendVersion, call);
  }

  /**
   * Records the not-found lookup and a send attempt, and bumps the version, in one committed
   * transaction before the sink is called. A competing reconciler that decided against the claim
   * version can no longer move the row, and a second send attempt for the delivery cannot commit.
   */
  private async authoriseSend(id: string, claimVersion: number, lookupStartedAt: string): Promise<number | null> {
    try {
      return await this.transaction(async (client) => {
        await recordLookup(client, id, lookupStartedAt, 'not_found');
        const bumped = await client.query<{ version: number }>(
          "UPDATE notification_outbox SET version=version+1 WHERE id=$1 AND status='dispatching' AND version=$2 RETURNING version",
          [id, claimVersion]);
        if (bumped.rowCount !== 1) return null;
        await client.query(
          `INSERT INTO notification_delivery_attempt(outbox_id,installation_id,organisation_id,branch_id,kind,started_at)
           SELECT id,installation_id,organisation_id,branch_id,'send',$2 FROM notification_outbox WHERE id=$1`,
          [id, instantOf(this.clock)]);
        return bumped.rows[0]!.version;
      });
    } catch (error) {
      if (errorCode(error) === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  private recordSend(
    id: string, sendVersion: number, call: BoundedResult<DeliveryReceipt>,
  ): Promise<DispatchOutcome> {
    return this.transaction(async (client) => {
      const closeAttempt = (result: string, reason: string | null) => client.query(
        "UPDATE notification_delivery_attempt SET outcome=$2,reason=$3 WHERE outbox_id=$1 AND kind='send' AND outcome IS NULL",
        [id, result, reason]);
      if (call.kind === 'returned' && usableReceipt(call.value, id)) {
        await closeAttempt('delivered', null);
        return settleDelivered(client, id, call.value.receiptId, instantOf(this.clock));
      }
      const code = call.kind === 'threw' ? errorCode(call.error) : undefined;
      if (code === 'SINK_REFUSED') {
        // The sink proved it never accepted this request, and repeating it unchanged cannot help.
        await closeAttempt('refused', 'SINK_REFUSED');
        const moved = await guardedTransition(client, id, 'dispatching', sendVersion, 'manual_review', 'sink_refused');
        return outcome(id, moved ? 'manual_review' : 'unchanged', 'sink_refused');
      }
      // Every other result is an unknown outcome, including one that looks like a clean refusal to
      // connect: an adapter cannot prove a notification was not delivered.
      const reason = call.kind === 'timed_out' ? 'timed_out'
        : call.kind === 'returned' ? 'invalid_receipt'
          : typeof code === 'string' && SAFE_REASON.test(code) ? code : 'send_failed';
      await closeAttempt(call.kind === 'timed_out' ? 'timed_out' : 'failed', reason);
      const moved = await guardedTransition(client, id, 'dispatching', sendVersion, 'outcome_unknown', reason);
      return outcome(id, moved ? 'outcome_unknown' : 'unchanged', reason);
    });
  }
}
