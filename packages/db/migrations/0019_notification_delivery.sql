-- Durable alert episodes and their delivery outbox. docs/alerting.md described the reducer as
-- having no persistence and no channel; this migration supplies the persistence half only. Nothing
-- here reaches a device: the delivery adapter is the synthetic file sink in packages/notifications,
-- and a real channel is a later decision.
--
-- inventory_alert is deliberately untouched. That table reserves an identity per (organisation,
-- source_ref) and is not an episode: it has no severity, no signal count, no open/resolved state and
-- no delivery. Widening it in place would change the meaning of rows written by migration 0004.
--
-- Integrated from the synthetic-alert-delivery lane, which numbered this 0016 against base 9584ace.
-- The review findings that reshaped it are recorded in docs/testing/synthetic-alert-delivery.md.

CREATE TABLE notification_policy (
 organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','active','disabled')),
 -- A window is observed only when this says so. Without it, a zeroed or half-written row would be
 -- indistinguishable from a deliberate decision to keep no quiet hours, and would deliver at once.
 quiet_hours_enabled boolean NOT NULL,
 quiet_start_minute integer NOT NULL CHECK(quiet_start_minute BETWEEN 0 AND 1439),
 quiet_end_minute integer NOT NULL CHECK(quiet_end_minute BETWEEN 0 AND 1439),
 bypass_severities text[] NOT NULL DEFAULT '{}'
  CHECK(bypass_severities <@ ARRAY['informational','actionable','critical'] AND cardinality(bypass_severities)<=3),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(organisation_id,branch_id),
 -- An enabled window whose ends are equal means "never quiet" to the scheduler. Refuse it here too,
 -- so the application's refusal and the stored shape cannot drift apart.
 CHECK(NOT quiet_hours_enabled OR quiet_start_minute <> quiet_end_minute),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id)
);
COMMENT ON TABLE notification_policy IS 'Explicit per-branch quiet-hours configuration. The time zone is not stored here: it is branch.timezone, so one branch cannot hold two disagreeing local clocks. Absence of a row is refused as policy_missing and never read as "no quiet hours".';

-- One row per installation. Taking it FOR UPDATE is the per-installation serialisation point for
-- accepting a signal, and it carries the episode sequence. It deliberately holds no reducer state:
-- episodes live in notification_episode, where an index rather than a JSON document enforces them.
CREATE TABLE notification_alert_state (
 installation_id uuid PRIMARY KEY, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 episode_sequence integer NOT NULL DEFAULT 0 CHECK(episode_sequence>=0),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);

CREATE TABLE notification_episode (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 installation_id uuid NOT NULL, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 -- The reducer's per-installation sequence ("ep-7"). It is not exposed to a device; the opaque id
 -- above is what a delivery payload carries.
 episode_ref text NOT NULL CHECK(episode_ref ~ '^ep-[1-9][0-9]{0,9}$'),
 condition_key text NOT NULL CHECK(condition_key <> '' AND length(condition_key)<=256),
 severity text NOT NULL CHECK(severity IN ('informational','actionable','critical')),
 status text NOT NULL CHECK(status IN ('open','resolved')),
 opened_at timestamptz NOT NULL, last_signal_at timestamptz NOT NULL,
 resolved_at timestamptz,
 signal_count integer NOT NULL CHECK(signal_count>0),
 -- Set when an episode was recorded without a delivery, so a suppressed alert is still visible and
 -- carries the reason it was suppressed rather than looking like a delivery that never ran.
 suppressed_reason text CHECK(suppressed_reason IS NULL OR length(suppressed_reason)<=64),
 CHECK((status='resolved') = (resolved_at IS NOT NULL)),
 UNIQUE(installation_id,episode_ref),
 -- Target of the tenant-bound foreign keys below: a child row names the episode and its whole scope.
 UNIQUE(id,installation_id,organisation_id,branch_id),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
-- Coalescing as a database fact. Two transactions that both believe a condition has no open episode
-- cannot both commit one; the serialisation lock is the mechanism and this index is the guarantee.
CREATE UNIQUE INDEX notification_episode_one_open ON notification_episode(installation_id,condition_key)
 WHERE status='open';
COMMENT ON COLUMN notification_episode.condition_key IS 'Identifies the condition, typically installation and source code. It is tenant data and must never reach a delivery payload.';

CREATE TABLE notification_signal (
 installation_id uuid NOT NULL, signal_id text NOT NULL CHECK(signal_id <> '' AND length(signal_id)<=128),
 organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 episode_id uuid NOT NULL,
 accepted_at timestamptz NOT NULL,
 PRIMARY KEY(installation_id,signal_id),
 -- A foreign key check ignores row level security. Binding the episode to this row's own scope keeps
 -- one tenant from attaching evidence to, or probing for, another tenant's episode identifier.
 FOREIGN KEY(episode_id,installation_id,organisation_id,branch_id)
  REFERENCES notification_episode(id,installation_id,organisation_id,branch_id),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
COMMENT ON TABLE notification_signal IS 'Accepted signal identities with the content hash that identity carried. A replay of identical content is a duplicate; the same identity with a different hash is refused as a conflict rather than overwriting the first.';

CREATE TABLE notification_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organisation_id uuid NOT NULL, branch_id uuid NOT NULL, installation_id uuid NOT NULL,
 -- One delivery per episode, enforced by the database rather than by the code that inserts it.
 episode_id uuid NOT NULL UNIQUE,
 severity text NOT NULL CHECK(severity IN ('informational','actionable','critical')),
 deliver_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending','dispatching','delivered','outcome_unknown','manual_review','held')),
 deferrals integer NOT NULL DEFAULT 0 CHECK(deferrals>=0 AND deferrals<=1000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 lease_expires_at timestamptz, settled_at timestamptz,
 last_reason text CHECK(last_reason IS NULL OR length(last_reason)<=64),
 receipt_id text CHECK(receipt_id IS NULL OR length(receipt_id)<=128),
 payload jsonb NOT NULL,
 -- What leaves the system, constrained by shape rather than by trust in the writer: exactly four
 -- keys, the title one of the redacted templates packages/alerting produces and the body its fixed
 -- instruction. A later edit that puts a product name or a quantity into the payload fails here.
 -- The whole expression is coalesced to false: a JSON null would otherwise make a comparison NULL,
 -- and a CHECK that evaluates to NULL passes.
 CONSTRAINT notification_outbox_payload_shape CHECK(coalesce(
  jsonb_typeof(payload)='object'
  AND payload ?& ARRAY['episodeId','installationId','title','body']
  AND payload - 'episodeId' - 'installationId' - 'title' - 'body' = '{}'::jsonb
  AND jsonb_typeof(payload->'episodeId')='string' AND jsonb_typeof(payload->'installationId')='string'
  AND jsonb_typeof(payload->'title')='string' AND jsonb_typeof(payload->'body')='string'
  AND payload->>'title' IN ('Stock update','Stock needs attention','Urgent stock issue')
  AND payload->>'body' = 'Open PharmaCart to review this alert.'
  -- The payload names its own episode and installation and no other identity.
  AND payload->>'episodeId'=episode_id::text AND payload->>'installationId'=installation_id::text,
  false)),
 CONSTRAINT notification_outbox_settled_receipt CHECK((status='delivered') = (receipt_id IS NOT NULL)),
 -- A lease describes a claim in progress and nothing else, so an expired lease is always evidence
 -- about an abandoned dispatch and never a leftover from a settled one.
 CONSTRAINT notification_outbox_lease_only_while_dispatching CHECK((status='dispatching') = (lease_expires_at IS NOT NULL)),
 UNIQUE(id,installation_id,organisation_id,branch_id),
 FOREIGN KEY(episode_id,installation_id,organisation_id,branch_id)
  REFERENCES notification_episode(id,installation_id,organisation_id,branch_id),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
CREATE INDEX notification_outbox_due ON notification_outbox(deliver_at,id) WHERE status='pending';
CREATE INDEX notification_outbox_unsettled ON notification_outbox(deliver_at,id)
 WHERE status IN ('dispatching','outcome_unknown');

-- Every sink call a dispatcher makes for a delivery. A send is recorded, with no outcome, in the
-- same committed transaction that authorises it and before the sink is called, so a crash during
-- the call still leaves evidence that a send may have happened.
CREATE TABLE notification_delivery_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 outbox_id uuid NOT NULL, installation_id uuid NOT NULL, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('send','lookup')),
 -- The injected clock's instant when the call began. Synthetic clocks are often frozen, so this
 -- cannot order attempts; recorded_at below is the database's own insertion order for that purpose
 -- and is never read by delivery logic.
 started_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text,
 reason text CHECK(reason IS NULL OR length(reason)<=64),
 CONSTRAINT notification_delivery_attempt_outcome CHECK(
  (kind='send' AND (outcome IS NULL OR outcome IN ('delivered','failed','timed_out','refused','abandoned')))
  OR (kind='lookup' AND outcome IN ('found','not_found','failed','timed_out'))),
 FOREIGN KEY(outbox_id,installation_id,organisation_id,branch_id)
  REFERENCES notification_outbox(id,installation_id,organisation_id,branch_id)
);
-- The strongest duplicate-push guarantee this schema can give: whatever the code does, a second send
-- for one delivery cannot be authorised, because its attempt row cannot be committed.
CREATE UNIQUE INDEX notification_delivery_attempt_one_send ON notification_delivery_attempt(outbox_id)
 WHERE kind='send';
CREATE INDEX notification_delivery_attempt_lookups ON notification_delivery_attempt(outbox_id)
 WHERE kind='lookup';

-- Delivery is terminal. A delivered row returning to pending would re-send a notification that a
-- person has already seen, which is the one failure this whole module exists to prevent. Recording
-- the receipt is part of the same statement that marks it delivered, so neither can arrive alone.
CREATE FUNCTION pharmacart_reject_notification_redelivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF NEW.status IS DISTINCT FROM 'delivered' OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
  RAISE EXCEPTION 'notification delivery is terminal: %', OLD.id
   USING ERRCODE='check_violation', DETAIL='terminal_state',
         HINT='A delivered notification is never re-queued; open a new episode instead.';
 END IF;
 RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION pharmacart_reject_notification_redelivery() FROM PUBLIC;
CREATE TRIGGER notification_outbox_terminal_delivery BEFORE UPDATE ON notification_outbox
 FOR EACH ROW WHEN (OLD.status='delivered') EXECUTE FUNCTION pharmacart_reject_notification_redelivery();

-- A recorded attempt outcome is evidence. It may be written once, and only the outcome and reason
-- may be written at all; the column grant below enforces the second half for the runtime.
CREATE FUNCTION pharmacart_reject_attempt_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 RAISE EXCEPTION 'notification delivery attempt outcome is already recorded: %', OLD.id
  USING ERRCODE='check_violation', DETAIL='terminal_state';
END
$function$;
REVOKE ALL ON FUNCTION pharmacart_reject_attempt_rewrite() FROM PUBLIC;
CREATE TRIGGER notification_delivery_attempt_recorded_once BEFORE UPDATE ON notification_delivery_attempt
 FOR EACH ROW WHEN (OLD.outcome IS NOT NULL) EXECUTE FUNCTION pharmacart_reject_attempt_rewrite();

DO $rls$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['notification_policy','notification_alert_state','notification_episode','notification_signal','notification_outbox','notification_delivery_attempt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id()) WITH CHECK (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())',table_name);
 END LOOP;
END $rls$;

REVOKE ALL ON notification_policy,notification_alert_state,notification_episode,notification_signal,notification_outbox,notification_delivery_attempt FROM PUBLIC;
-- Policy is administrative configuration: the runtime reads it and can never write it, so a request
-- path defect cannot widen a quiet window or add a bypass severity for itself.
GRANT SELECT ON notification_policy TO pharmacart_runtime;
-- No DELETE anywhere below. An accepted signal, an episode, a delivery record and every attempt are
-- evidence; the runtime may advance them and may not erase them.
GRANT SELECT,INSERT ON notification_alert_state,notification_episode,notification_outbox TO pharmacart_runtime;
-- UPDATE is granted per column, and only on the columns packages/db/src/notifications.ts writes. What a
-- row is about (its tenant, installation, condition, episode, severity and payload) is fixed at insert,
-- so a request path defect cannot re-point a delivery or rewrite what it will say. A column grant is also
-- enough for the SELECT ... FOR UPDATE those modules take.
GRANT UPDATE(episode_sequence) ON notification_alert_state TO pharmacart_runtime;
GRANT UPDATE(severity,last_signal_at,signal_count,status,resolved_at) ON notification_episode TO pharmacart_runtime;
GRANT UPDATE(status,deliver_at,deferrals,version,lease_expires_at,settled_at,last_reason,receipt_id)
 ON notification_outbox TO pharmacart_runtime;
GRANT SELECT,INSERT ON notification_signal TO pharmacart_runtime;
GRANT SELECT,INSERT ON notification_delivery_attempt TO pharmacart_runtime;
GRANT UPDATE(outcome,reason) ON notification_delivery_attempt TO pharmacart_runtime;
