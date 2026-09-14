-- Attempt, lease and evidence state for receipt writeback, plus an append-only record of every sink call.
--
-- receipt_writeback.status keeps its two-value domain (queued, applied) and is NOT extended here. 'queued'
-- must keep meaning "not proven delivered to the stock system", so an uncertain or held writeback stays
-- queued and anything that conservatively holds a receipt keeps working. All in-flight state lives in
-- receipt_writeback_attempt instead.
--
-- BOUNDARY. 'applied' is delivery evidence only. It does not prove that any later inventory snapshot
-- contains the received stock, and nothing in this migration or in the writeback processor records
-- inclusion. The inclusion columns added by 0014 belong to a separate inclusion writer and stay NULL here.
-- See docs/receipt-writeback.md and docs/RELEASE-GATE.md.

-- Tenant identity of a writeback as a referenceable key, so child rows can be bound to the tenant of the
-- writeback they describe rather than merely to its id. A bare id reference is checked with row security
-- bypassed, which would let a worker in one tenant attach attempt rows to another tenant's writeback: the
-- row it inserted would carry its own tenant columns and pass its own policy while squatting the other
-- tenant's primary key.
ALTER TABLE receipt_writeback ADD CONSTRAINT receipt_writeback_tenant_identity UNIQUE(organisation_id,branch_id,id);

CREATE TABLE receipt_writeback_attempt(
 writeback_id uuid PRIMARY KEY,
 organisation_id uuid NOT NULL,branch_id uuid NOT NULL,
 sink_key text NOT NULL CHECK(sink_key ~ '^pc-syn-wb-[0-9a-f]{32}$'),
 payload_hash text CHECK(payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
 phase text NOT NULL CHECK(phase IN ('pending','checking','submitting','outcome_unknown','needs_reconciliation','applied')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
 lease_token uuid,
 lease_expires_at timestamptz,
 not_before timestamptz,
 sink_receipt_token text CHECK(sink_receipt_token IS NULL OR sink_receipt_token ~ '^pc-syn-stock-[0-9a-f]{32}$'),
 hold_reason text CHECK(hold_reason IS NULL OR hold_reason ~ '^[a-z_]{1,64}$'),
 last_reason text NOT NULL CHECK(last_reason ~ '^[a-z_]{1,64}$'),
 last_detail text CHECK(last_detail IS NULL OR length(last_detail)<=1024),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organisation_id,branch_id,writeback_id) REFERENCES receipt_writeback(organisation_id,branch_id,id),
 -- One stock receipt key per tenant.
 UNIQUE(organisation_id,branch_id,sink_key),
 -- A lease is wholly present or wholly absent.
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 -- A pre-send lookup or a send is only ever in flight under a lease, so an abandoned one is recoverable.
 CHECK(phase NOT IN ('checking','submitting') OR lease_token IS NOT NULL),
 -- Idle and terminal phases hold no lease: a held or applied writeback is never re-claimed on expiry.
 CHECK(phase NOT IN ('pending','needs_reconciliation','applied') OR lease_token IS NULL),
 -- There is no path to applied without the sink's positive evidence for a recorded payload.
 CHECK(phase<>'applied' OR (sink_receipt_token IS NOT NULL AND payload_hash IS NOT NULL)),
 -- A token outside applied survives only on a hold, where an attempt that recorded applied disagrees with a
 -- still-queued writeback and the evidence is kept for the operator rather than erased.
 CHECK(sink_receipt_token IS NULL OR phase IN ('applied','needs_reconciliation')),
 -- Only a writeback held because its payload could not be built may lack a payload hash.
 CHECK(payload_hash IS NOT NULL OR phase='needs_reconciliation'),
 -- Every hold names its reason, and nothing else carries one.
 CHECK((phase='needs_reconciliation')=(hold_reason IS NOT NULL)),
 -- A retry delay only applies to a phase a worker may claim again.
 CHECK(not_before IS NULL OR phase IN ('pending','outcome_unknown')));

CREATE INDEX receipt_writeback_attempt_claimable ON receipt_writeback_attempt(organisation_id,branch_id,phase,lease_expires_at,not_before)
 WHERE phase IN ('pending','checking','submitting','outcome_unknown');

ALTER TABLE receipt_writeback_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_writeback_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON receipt_writeback_attempt
 USING(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())
 WITH CHECK(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id());
-- No DELETE: a writeback that ended in refusal must stay inspectable. UPDATE is column-level and limited to
-- exactly the columns packages/db/src/writeback.ts writes, including through INSERT ... ON CONFLICT DO
-- UPDATE. writeback_id, organisation_id, branch_id, sink_key, payload_hash and created_at are fixed once
-- inserted: an attempt cannot be moved to another writeback or tenant, re-keyed, or have the payload it
-- vouched for rewritten. Column-level UPDATE also satisfies the privilege SELECT ... FOR UPDATE requires.
-- packages/writeback/test/attempt-grants.test.ts keeps this list equal to the processor's writes.
GRANT SELECT,INSERT ON receipt_writeback_attempt TO pharmacart_runtime;
GRANT UPDATE(phase,attempts,lease_token,lease_expires_at,not_before,sink_receipt_token,hold_reason,last_reason,last_detail,updated_at)
 ON receipt_writeback_attempt TO pharmacart_runtime;

-- One row per sink call and per claim-time hold. Append-only for the runtime role: no UPDATE, no DELETE.
CREATE TABLE receipt_writeback_attempt_log(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organisation_id uuid NOT NULL,branch_id uuid NOT NULL,writeback_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 100),
 step text NOT NULL CHECK(step IN ('lookup','apply','decision')),
 result text NOT NULL CHECK(result IN ('found','not_found','inconclusive','acknowledged','not_recorded','refused','no_answer','held')),
 reason text NOT NULL CHECK(reason ~ '^[a-z_]{1,64}$'),
 detail text CHECK(detail IS NULL OR length(detail)<=1024),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organisation_id,branch_id,writeback_id) REFERENCES receipt_writeback(organisation_id,branch_id,id),
 CHECK((step='lookup' AND result IN ('found','not_found','inconclusive'))
  OR (step='apply' AND result IN ('acknowledged','not_recorded','refused','no_answer'))
  OR (step='decision' AND result='held')));

CREATE INDEX receipt_writeback_attempt_log_writeback ON receipt_writeback_attempt_log(writeback_id,recorded_at);

ALTER TABLE receipt_writeback_attempt_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_writeback_attempt_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON receipt_writeback_attempt_log
 USING(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())
 WITH CHECK(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id());
GRANT SELECT,INSERT ON receipt_writeback_attempt_log TO pharmacart_runtime;

COMMENT ON TABLE receipt_writeback_attempt IS
 'Per-writeback attempt, lease and evidence state for delivery to a stock system; at most one row per receipt_writeback row. It exists so receipt_writeback.status can keep meaning only queued or applied. Applied here is delivery evidence only and never snapshot inclusion.';

COMMENT ON COLUMN receipt_writeback_attempt.phase IS
 'pending: nothing is in flight and the last attempt provably sent nothing; claimable once not_before has passed. checking: a claim is looking the stock receipt up before any send, so nothing has been sent by it; an expired checking claim is safe to check again. submitting: the claim committed its intent to send before calling the sink, so recovering it requires a lookup and never a resend. outcome_unknown: a send returned no answer; only a lookup may settle it. needs_reconciliation: held for an operator with hold_reason; no worker claims it, although matching positive evidence from a send that was already under way may still record it applied. applied: the sink returned positive evidence matching payload_hash.';

COMMENT ON COLUMN receipt_writeback_attempt.lease_token IS
 'Identity of one claim, minted per claim rather than per worker. Only the claim holding this token may move the attempt to any non-applied phase, so two concurrent calls in one worker are as isolated from each other as two workers are.';

COMMENT ON COLUMN receipt_writeback_attempt.lease_expires_at IS
 'Database-clock expiry of the current claim. Every sink call runs under a lease freshly extended by the processor and is abandoned well before it expires.';

COMMENT ON COLUMN receipt_writeback_attempt.not_before IS
 'Earliest database time a released attempt may be claimed again, so a transient refusal cannot exhaust every attempt inside one run.';

COMMENT ON COLUMN receipt_writeback_attempt.sink_key IS
 'Stable stock receipt identity derived from organisation, branch and receipt only, so a restored database resolves to the same stock receipt instead of creating a second one.';

COMMENT ON COLUMN receipt_writeback_attempt.payload_hash IS
 'Hash of the exact receipt content that was, or is being, sent. A recomputed hash that differs holds the writeback for an operator rather than resending it. NULL only when the payload could not be built at all.';

COMMENT ON COLUMN receipt_writeback_attempt.sink_receipt_token IS
 'Positive evidence from the stock sink that this exact payload was recorded under this exact key. BOUNDARY: it proves delivery, not that any later inventory snapshot, projection or watermark includes the stock, and it must never be used to clear a replenishment hold.';

COMMENT ON TABLE receipt_writeback_attempt_log IS
 'Append-only record of every lookup and apply the writeback processor made, and every hold decided without a sink call, with its named reason. A call whose settling transaction rolled back is not recorded; its attempt stays in a phase that forces a lookup.';
