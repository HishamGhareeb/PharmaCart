import type { RuntimeClient } from './runtime.ts';

/** Refusal raised by quoting and approval when the outstanding remainder of a need is not proven. */
export const reconciliationRequiredCode = 'RECONCILIATION_REQUIRED';

/** Ordered by precedence: the lowest-indexed reason wins when several apply to one need, and the
 * one-based index is the rank the reconciliation query aggregates with. Migration 0014 constrains the
 * stored column to exactly these values. */
export const holdReasons = [
  'unknown_order_state',
  'receipt_inclusion_unproven',
  'commitment_unit_mismatch',
  'unverified_commitment',
] as const;
export type HoldReason = (typeof holdReasons)[number];
const holdRank = (reason: HoldReason): number => holdReasons.indexOf(reason) + 1;

export type NeedStatus = 'open' | 'quoted' | 'covered' | 'closed';

// ---------------------------------------------------------------------------------------------------------
// Identifiers
//
// PostgreSQL casts upper case, braced and unhyphenated spellings to the same uuid, and raises 22P02 for
// anything else. Neither behaviour is safe here. The accepted spellings are different strings to JavaScript,
// so they split a duplicate check, a per-supplier grouping and approval's lock order away from the row they
// name; the rejected ones abort the caller's transaction instead of naming the problem. So only one spelling
// is accepted, and it is checked before any statement runs.

const canonicalUuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const canonicalUuid = new RegExp(canonicalUuidPattern);
const nilUuid = '00000000-0000-0000-0000-000000000000';

export type IdentifierRefusalReason = 'not_a_string' | 'malformed' | 'non_canonical' | 'nil';
export type CanonicalUuidDecision =
  | Readonly<{ kind: 'canonical'; value: string }>
  | Readonly<{ kind: 'refused'; reason: IdentifierRefusalReason }>;

/**
 * Whether a value is a canonical UUID: lowercase, hyphenated 8-4-4-4-12, and not the nil UUID. Version and
 * variant are not policed, matching the API selector and the contract pattern. A spelling that is the same
 * 128 bits written differently is `non_canonical` rather than `malformed`, because it is the dangerous one:
 * the database would accept it.
 */
export function decideCanonicalUuid(value: unknown): CanonicalUuidDecision {
  if (typeof value !== 'string') return { kind: 'refused', reason: 'not_a_string' };
  if (canonicalUuid.test(value)) {
    // No row carries the nil UUID, so a caller holding one is holding a default, not an identity.
    return value === nilUuid ? { kind: 'refused', reason: 'nil' } : { kind: 'canonical', value };
  }
  const digits = value.replace(/^\{(.*)\}$/, '$1').replaceAll('-', '');
  return { kind: 'refused', reason: /^[0-9a-fA-F]{32}$/.test(digits) ? 'non_canonical' : 'malformed' };
}

/**
 * Orders canonical UUIDs exactly as the uuid type does, which is the order `ORDER BY id` locks rows in.
 * Lowercase hexadecimal compares byte-wise as code units, so this needs no collation and cannot vary by
 * locale. It is only meaningful for values decideCanonicalUuid accepted.
 */
export function compareCanonicalUuids(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type NeedReconciliationRefusal =
  | Readonly<{ kind: 'invalid_identifier'; field: string; reason: IdentifierRefusalReason }>
  | Readonly<{ kind: 'need_not_visible'; needId: string }>;

/** A refusal by name from reconciliation. Nothing has been read, locked or written when it is raised for an
 * identifier; a need that is not visible is refused rather than reported as having no hold. */
export class NeedReconciliationError extends Error {
  readonly refusal: NeedReconciliationRefusal;
  constructor(refusal: NeedReconciliationRefusal) {
    super(refusal.kind);
    this.name = 'NeedReconciliationError';
    this.refusal = refusal;
  }
}

function requireCanonicalUuid(field: string, value: unknown): string {
  const decision = decideCanonicalUuid(value);
  if (decision.kind === 'refused') {
    throw new NeedReconciliationError({ kind: 'invalid_identifier', field, reason: decision.reason });
  }
  return decision.value;
}

// ---------------------------------------------------------------------------------------------------------
// Commitment policy

/**
 * How much of an order counts as a commitment against a need, per intent state.
 *
 * A queued intent is a reservation this system made itself, so its quoted ordered quantity is known
 * exactly. An acknowledged intent contributes what the supplier accepted and has not yet delivered.
 * A rejected intent is settled and contributes nothing; leaving it counted would suppress real demand
 * forever. The three remaining states describe an order whose quantity nobody can state, and the
 * deliberate answer there is to hold replenishment rather than assign it a guess: guessing low
 * double-orders, guessing high leaves the pharmacy short of something it already knew it needed.
 *
 * The reconciliation query receives these groupings as parameters rather than repeating them, so the
 * SQL and the pure decision below cannot drift apart.
 */
export const commitmentBasisByIntentState = {
  queued: 'quoted_ordered',
  submitting: 'unresolved',
  outcome_unknown: 'unresolved',
  human_review: 'unresolved',
  acknowledged: 'accepted_not_received',
  rejected: 'settled',
} as const;
export type IntentState = keyof typeof commitmentBasisByIntentState;
export type CommitmentBasis = (typeof commitmentBasisByIntentState)[IntentState];

const modelledIntentStates = Object.keys(commitmentBasisByIntentState) as IntentState[];
const statesWith = (basis: CommitmentBasis): string[] =>
  modelledIntentStates.filter((state) => commitmentBasisByIntentState[state] === basis);

/** Order states whose committed quantity is unknowable. Quoting and approval consult these live. */
export const unresolvedIntentStates: readonly string[] = statesWith('unresolved');
const settledIntentStates = statesWith('settled');
const acceptedIntentStates = statesWith('accepted_not_received');
const quotedOrderedIntentStates = statesWith('quoted_ordered');

export type CommitmentFacts = Readonly<{
  intentState: string;
  unitMatchesTarget: boolean;
  hasOrderLine: boolean;
  hasReadableQuotedQuantity: boolean;
}>;
export type CommitmentDecision =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'count'; basis: 'quoted_ordered' | 'accepted_not_received' }>
  | Readonly<{ kind: 'hold'; reason: HoldReason }>;

/**
 * The commitment rule for one order line against one need. Every path that cannot prove a quantity
 * ends in a hold rather than a zero, because a zero is indistinguishable from "nothing is on order"
 * and that is the reading that buys the same boxes twice.
 */
export function decideCommitment(facts: CommitmentFacts): CommitmentDecision {
  const basis = (commitmentBasisByIntentState as Record<string, CommitmentBasis | undefined>)[facts.intentState];
  // A state this build does not model may mean anything, so it is refused rather than interpreted.
  if (basis === undefined) return { kind: 'hold', reason: 'unverified_commitment' };
  if (basis === 'unresolved') return { kind: 'hold', reason: 'unknown_order_state' };
  // A settled order carries no quantity into the comparison, so nothing about it needs proving.
  if (basis === 'settled') return { kind: 'settled' };
  // Comparing a target in boxes against a commitment in strips needs a versioned pack agreement.
  // Inventing one here would quietly change how much gets bought.
  if (!facts.unitMatchesTarget) return { kind: 'hold', reason: 'commitment_unit_mismatch' };
  if (basis === 'accepted_not_received') {
    return facts.hasOrderLine ? { kind: 'count', basis } : { kind: 'hold', reason: 'unverified_commitment' };
  }
  // A queued intent has no order line until a worker claims it, so the quoted quantity carries it.
  return facts.hasOrderLine || facts.hasReadableQuotedQuantity
    ? { kind: 'count', basis }
    : { kind: 'hold', reason: 'unverified_commitment' };
}

export type ReceiptInclusionFacts = Readonly<{
  writebackApplied: boolean;
  inclusionRecorded: boolean;
  /** A fresh, matching-unit observation either of the including snapshot itself (same sequence and the same
   * snapshot identity) or of a later sequence. A different snapshot at the same sequence does not count. */
  observationAtOrAfterInclusion: boolean;
}>;

/**
 * Whether a confirmed receipt can be treated as already reflected in observed stock.
 *
 * An applied writeback is delivery evidence and nothing more. It says the stock system was told; it
 * does not say which export ran afterwards, so the snapshot being compared against may predate the
 * write. Reading 'applied' as inclusion loses that race in both directions: count the received boxes
 * on both sides and the pharmacy under-orders, count them on neither and it buys them twice.
 *
 * So inclusion is proven positively or not at all — the writeback must name the snapshot that carries
 * the receipt, and the installation must have observed that snapshot or a fresh one beyond it. Every
 * other combination, including a receipt with no writeback record at all, leaves the affected need held
 * rather than replenished on a guess.
 */
export function isReceiptInclusionProven(facts: ReceiptInclusionFacts): boolean {
  return facts.writebackApplied && facts.inclusionRecorded && facts.observationAtOrAfterInclusion;
}

export type HoldObservation = Readonly<{
  storedReason: HoldReason | null;
  unresolvedOrder: boolean;
  receiptInclusionUnproven: boolean;
  /** A live order line names no need or supplier that can be matched exactly, so it could belong to any need. */
  unattributableCommitment: boolean;
}>;

/**
 * The hold a commercial decision must honour right now: the strongest of the reasons live order state
 * shows and the reason the last recalculation stored. The stored reason is only a cache — an order can
 * lose its outcome after a feed and before the next quote — so live evidence always counts, and a clean
 * live read never clears a reason the cache alone can see.
 */
export function resolveHold(observation: HoldObservation): HoldReason | null {
  const candidates: ReadonlyArray<HoldReason | null> = [
    observation.unresolvedOrder ? 'unknown_order_state' : null,
    observation.receiptInclusionUnproven ? 'receipt_inclusion_unproven' : null,
    observation.unattributableCommitment ? 'unverified_commitment' : null,
    observation.storedReason,
  ];
  return candidates.reduce<HoldReason | null>((strongest, reason) =>
    reason !== null && (strongest === null || holdRank(reason) < holdRank(strongest)) ? reason : strongest, null);
}

export type NeedFacts = Readonly<{
  hasNeed: boolean;
  needStatus: NeedStatus | null;
  held: boolean;
  observationUsable: boolean;
  shortfallSign: -1 | 0 | 1;
  remainderChanged: boolean;
}>;
export type NeedOutcome = 'hold' | 'preserve' | 'open_new' | 'update_remainder' | 'reopen' | 'close';

/**
 * What one target does to its need row. Three separate reasons lead to leaving the row alone, and
 * keeping them distinct is the point: a held need is one whose remainder cannot be proven, an unusable
 * observation is stock this system has not seen rather than stock that is absent, and an unchanged
 * remainder must not bump the version that outstanding quotes are pinned to.
 */
export function decideNeedOutcome(facts: NeedFacts): NeedOutcome {
  if (facts.held) return facts.hasNeed ? 'hold' : 'preserve';
  // A missing or stale observation is unknown, not empty, so it can neither create nor erase a need.
  if (!facts.observationUsable) return 'preserve';
  if (facts.shortfallSign === 1) {
    if (!facts.hasNeed) return 'open_new';
    // A commitment that was rejected or settled leaves real demand behind, so a retired need returns.
    if (facts.needStatus === 'covered' || facts.needStatus === 'closed') return 'reopen';
    if (facts.needStatus !== 'open') return 'preserve';
    return facts.remainderChanged ? 'update_remainder' : 'preserve';
  }
  // Held stock plus commitments now meet the target. requested_quantity must stay positive, so the
  // need retires at its last requested quantity instead of being written down to zero.
  return facts.hasNeed && facts.needStatus === 'open' ? 'close' : 'preserve';
}

// ---------------------------------------------------------------------------------------------------------
// SQL
//
// quote.lines and receipt.lines are application-written jsonb with no shape constraint. No identifier read
// from them is ever cast to uuid: each is compared as text against the canonical rendering of a real key
// (`id::text`), which only a canonical spelling can equal. A line that matches nothing is not dropped — it is
// reported as unattributable and holds every need it could belong to.

/** True only for a text expression holding a canonical, non-nil UUID. Never raises. */
const isCanonicalUuidText = (expression: string) =>
  `coalesce(${expression} ~ '${canonicalUuidPattern}' AND ${expression} <> '${nilUuid}', false)`;

/** The elements of a stored line list. Anything but a non-empty array yields one null element, which names
 * nothing and so surfaces as unattributable, where jsonb_array_elements would otherwise raise or yield no
 * rows. CASE branches are evaluated in order, so jsonb_array_length never sees a non-array. */
const storedLines = (column: string) => `jsonb_array_elements(CASE
      WHEN coalesce(jsonb_typeof(${column}), 'null') <> 'array' THEN '[null]'::jsonb
      WHEN jsonb_array_length(${column}) = 0 THEN '[null]'::jsonb
      ELSE ${column} END)`;

/**
 * Needs touched by a receipt whose arrival in stock is not proven, which is the SQL form of
 * isReceiptInclusionProven. Both the recalculation and the commercial refusal read this one query, so
 * a need cannot be held by one and quotable by the other.
 *
 * It starts from the receipt, not the writeback, so a receipt with no writeback record is unproven rather
 * than invisible. A receipt line names an order line by canonical text; a line naming none of its order's
 * lines cannot be attributed, so every need of that order is held. The inclusion point is compared against
 * the projection of the need's own source code: the including snapshot itself at the recorded sequence, or
 * any fresh snapshot beyond it. An absent, stale or wrong-unit projection is not evidence of anything.
 */
const receiptInclusionUnproven = `SELECT DISTINCT l.need_id
    FROM receipt r
    LEFT JOIN receipt_writeback w ON w.receipt_id = r.id
    JOIN order_line l ON l.intent_id = r.intent_id
    JOIN need rn ON rn.id = l.need_id
    LEFT JOIN inventory_target rt
      ON rn.source_ref = rt.installation_id::text || ':' || rt.source_code
    LEFT JOIN inventory_projection rp
      ON rp.installation_id = rt.installation_id AND rp.source_code = rt.source_code
   WHERE EXISTS (SELECT 1 FROM ${storedLines('r.lines')} AS rl
                  WHERE rl->>'lineId' = l.id::text
                     OR NOT EXISTS (SELECT 1 FROM order_line x
                                     WHERE x.intent_id = r.intent_id AND x.id::text = rl->>'lineId'))
     AND NOT coalesce(w.status = 'applied'
                      AND w.included_snapshot_id IS NOT NULL AND w.included_sequence IS NOT NULL
                      AND rp.installation_id IS NOT NULL AND NOT rp.stale AND rp.unit = rt.unit
                      AND (rp.sequence > w.included_sequence
                           OR (rp.sequence = w.included_sequence AND rp.snapshot_id = w.included_snapshot_id)),
                      false)`;

/**
 * Whether a live (unsettled) order in scope carries a quote line that cannot be attributed: a line whose
 * supplier matches no order of its quote, or whose need is not a canonical identifier. Its quantity could
 * belong to any need in scope, so counting it against none of them would double-order and guessing one
 * would be arbitrary. `scope` constrains the alias `ui`; `settled` is the parameter carrying settled states.
 */
const unattributableCommitment = (scope: string, settled: string) => `EXISTS (
    SELECT 1 FROM order_intent ui
      JOIN quote uq ON uq.id = ui.quote_id
      CROSS JOIN LATERAL ${storedLines('uq.lines')} AS ul
     WHERE ${scope}
       AND ui.state <> ALL(${settled}::text[])
       AND (NOT EXISTS (SELECT 1 FROM order_intent si
                         WHERE si.quote_id = uq.id AND si.supplier_id::text = ul->>'supplierId')
            OR (ul->>'supplierId' = ui.supplier_id::text AND NOT ${isCanonicalUuidText("ul->>'needId'")})))`;

/**
 * Needs carrying a target of this installation, locked in primary key order. Approval sorts its own
 * need locks the same way, so a recalculation and a concurrent approval queue rather than deadlock.
 */
const lockScopedNeeds = `SELECT n.id FROM need n
  JOIN inventory_target t ON n.source_ref = t.installation_id::text || ':' || t.source_code
 WHERE t.installation_id = $1
 ORDER BY n.id
   FOR UPDATE OF n`;

/**
 * One consistent read of targets, observations and commitments. All arithmetic stays in PostgreSQL
 * numeric: a target of 0.6 against 0.1 on hand and 0.2 on order is exactly 0.3 here, where a float
 * path gives 0.29999999999999993 and a need nobody can reconcile by hand.
 *
 * $2..$6 carry the intent state groupings of commitmentBasisByIntentState so this query cannot
 * disagree with decideCommitment about which state means what.
 */
const assessTargets = `WITH target AS (
  SELECT t.installation_id, t.organisation_id, t.branch_id, t.source_code, t.product_ref, t.unit,
         t.target_quantity, t.installation_id::text || ':' || t.source_code AS source_ref
    FROM inventory_target t
   WHERE t.installation_id = $1
), scoped_need AS (
  SELECT n.id, n.status, n.requested_quantity, n.hold_reason, g.source_ref, g.unit AS target_unit
    FROM need n JOIN target g ON g.source_ref = n.source_ref
), commitment_line AS (
  SELECT s.id AS need_id, i.state AS intent_state,
         (ql->>'unit' IS NOT DISTINCT FROM s.target_unit) AS unit_matches,
         (l.id IS NOT NULL) AS has_line, l.ordered, l.accepted, l.received,
         CASE WHEN ql->>'quantity' ~ '^[0-9]+([.][0-9]+)?$'
              THEN CASE WHEN (ql->>'quantity')::numeric > 0 THEN (ql->>'quantity')::numeric END
         END AS quoted_quantity
    FROM order_intent i
    JOIN quote q ON q.id = i.quote_id
    CROSS JOIN LATERAL ${storedLines('q.lines')} AS ql
    JOIN scoped_need s ON s.id::text = ql->>'needId'
    LEFT JOIN order_line l ON l.intent_id = i.id AND l.need_id = s.id
   WHERE ql->>'supplierId' = i.supplier_id::text
), commitment_ranked AS (
  SELECT c.*, CASE
           WHEN c.intent_state <> ALL($6::text[]) THEN ${holdRank('unverified_commitment')}
           WHEN c.intent_state = ANY($2::text[]) THEN ${holdRank('unknown_order_state')}
           WHEN c.intent_state = ANY($3::text[]) THEN NULL
           WHEN NOT c.unit_matches THEN ${holdRank('commitment_unit_mismatch')}
           WHEN c.intent_state = ANY($4::text[]) AND NOT c.has_line
             THEN ${holdRank('unverified_commitment')}
           WHEN c.intent_state = ANY($5::text[]) AND c.ordered IS NULL AND c.quoted_quantity IS NULL
             THEN ${holdRank('unverified_commitment')}
         END AS hold_rank
    FROM commitment_line c
), commitment AS (
  SELECT need_id, min(hold_rank) AS hold_rank,
         coalesce(sum(CASE
           WHEN hold_rank IS NOT NULL THEN NULL
           WHEN intent_state = ANY($4::text[]) THEN greatest(accepted - received, 0)
           WHEN intent_state = ANY($5::text[]) THEN coalesce(ordered, quoted_quantity)
         END), 0) AS committed
    FROM commitment_ranked
   GROUP BY need_id
), receipt_hold AS (
  ${receiptInclusionUnproven}
), unattributable AS (
  SELECT ${unattributableCommitment(
    '(ui.organisation_id, ui.branch_id) IN (SELECT organisation_id, branch_id FROM target)', '$3')} AS present
), observation AS (
  SELECT g.source_ref, p.quantity,
         (p.installation_id IS NOT NULL AND NOT p.stale AND p.unit = g.unit) AS usable
    FROM target g
    LEFT JOIN inventory_projection p
      ON p.installation_id = g.installation_id AND p.source_code = g.source_code
), assessed AS (
  SELECT g.source_ref, g.product_ref, g.organisation_id, g.branch_id,
         s.id AS need_id, s.status AS need_status, s.requested_quantity, o.usable,
         least(c.hold_rank,
               CASE WHEN rh.need_id IS NOT NULL THEN ${holdRank('receipt_inclusion_unproven')} END,
               CASE WHEN u.present THEN ${holdRank('unverified_commitment')} END) AS hold_rank,
         CASE WHEN o.usable THEN g.target_quantity - o.quantity - coalesce(c.committed, 0) END AS remainder
    FROM target g
    CROSS JOIN unattributable u
    LEFT JOIN scoped_need s ON s.source_ref = g.source_ref
    LEFT JOIN observation o ON o.source_ref = g.source_ref
    LEFT JOIN commitment c ON c.need_id = s.id
    LEFT JOIN receipt_hold rh ON rh.need_id = s.id
)
SELECT source_ref, product_ref, organisation_id::text AS organisation_id, branch_id::text AS branch_id,
       need_id::text AS need_id, need_status, hold_rank, coalesce(usable, false) AS usable,
       sign(remainder)::int AS shortfall_sign, remainder::text AS remainder,
       (requested_quantity IS DISTINCT FROM remainder) AS remainder_changed
  FROM assessed
 ORDER BY source_ref`;

/** $1 need, $2 unresolved intent states, $3 settled intent states. */
const readHold = `SELECT n.hold_reason,
  EXISTS (SELECT 1 FROM order_intent i
            JOIN quote q ON q.id = i.quote_id
            CROSS JOIN LATERAL ${storedLines('q.lines')} AS ql
           WHERE ql->>'supplierId' = i.supplier_id::text
             AND ql->>'needId' = n.id::text
             AND i.state = ANY($2::text[])) AS unresolved_order,
  EXISTS (SELECT 1 FROM (${receiptInclusionUnproven}) unproven
           WHERE unproven.need_id = n.id) AS pending_receipt,
  ${unattributableCommitment('ui.organisation_id = n.organisation_id AND ui.branch_id = n.branch_id', '$3')}
    AS unattributable_commitment
  FROM need n WHERE n.id = $1`;

type AssessedRow = {
  source_ref: string;
  product_ref: string;
  organisation_id: string;
  branch_id: string;
  need_id: string | null;
  need_status: NeedStatus | null;
  hold_rank: number | null;
  usable: boolean;
  shortfall_sign: number | null;
  remainder: string | null;
  remainder_changed: boolean;
};

function signOf(value: number | null): -1 | 0 | 1 {
  if (value === null || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * The hold that quoting and approval must honour for one need, or null when the remainder is proven.
 * Reads current order state as well as the cached flag, so an order that lost its outcome after the
 * last feed still refuses the next commercial decision.
 *
 * Refuses with NeedReconciliationError, before any statement, when `needId` is not a canonical UUID, and
 * after the read when the need is not visible in the current tenant scope: "no hold" would say its
 * remainder is proven.
 */
export async function readNeedHold(client: RuntimeClient, needId: string): Promise<HoldReason | null> {
  const need = requireCanonicalUuid('needId', needId);
  const row = (await client.query<{
    hold_reason: HoldReason | null;
    unresolved_order: boolean;
    pending_receipt: boolean;
    unattributable_commitment: boolean;
  }>(readHold, [need, unresolvedIntentStates, settledIntentStates])).rows[0];
  if (!row) throw new NeedReconciliationError({ kind: 'need_not_visible', needId: need });
  return resolveHold({
    storedReason: row.hold_reason,
    unresolvedOrder: row.unresolved_order,
    receiptInclusionUnproven: row.pending_receipt,
    unattributableCommitment: row.unattributable_commitment,
  });
}

/**
 * Recomputes the needs and shortage alerts of one installation from its coverage targets, its current
 * projection and everything already on order, replacing the target-minus-stock arithmetic that ran
 * inline after a completed projection revision.
 *
 * The caller supplies the transaction and the per-installation lock; this runs inside both. It refuses
 * with NeedReconciliationError, before any statement or row lock, when `installationId` is not a canonical
 * UUID. It then takes the affected need rows in primary key order, which is the order approval takes them
 * in, and writes only where a value actually changes, so recalculating an unchanged position bumps no
 * version and disturbs no alert episode.
 */
export async function reconcileInventoryNeeds(client: RuntimeClient, installationId: string): Promise<void> {
  const installation = requireCanonicalUuid('installationId', installationId);
  await client.query(lockScopedNeeds, [installation]);
  const assessed = (await client.query<AssessedRow>(assessTargets, [
    installation,
    unresolvedIntentStates,
    settledIntentStates,
    acceptedIntentStates,
    quotedOrderedIntentStates,
    modelledIntentStates,
  ])).rows;
  if (assessed.length === 0) return;

  // Every target of one installation shares its organisation and branch, and row level security has
  // already confined the read to the current one. Both identifiers are the database's own uuid::text.
  const organisationId = assessed[0]!.organisation_id;
  const branchId = assessed[0]!.branch_id;
  const heldIds: string[] = [];
  const heldReasons: HoldReason[] = [];
  const clearedIds: string[] = [];
  const openedRefs: string[] = [];
  const openedProducts: string[] = [];
  const openedQuantities: string[] = [];
  const updatedIds: string[] = [];
  const updatedQuantities: string[] = [];
  const reopenedIds: string[] = [];
  const reopenedQuantities: string[] = [];
  const closedIds: string[] = [];
  const raisedRefs: string[] = [];
  const retiredRefs: string[] = [];

  for (const row of assessed) {
    const reason = row.hold_rank === null ? null : holdReasons[row.hold_rank - 1]!;
    const shortfallSign = signOf(row.shortfall_sign);
    const outcome = decideNeedOutcome({
      hasNeed: row.need_id !== null,
      needStatus: row.need_status,
      held: reason !== null,
      observationUsable: row.usable,
      shortfallSign,
      remainderChanged: row.remainder_changed,
    });
    if (row.need_id !== null) {
      if (outcome === 'hold' && reason !== null) { heldIds.push(row.need_id); heldReasons.push(reason); }
      else clearedIds.push(row.need_id);
    }
    if (outcome === 'open_new') {
      openedRefs.push(row.source_ref);
      openedProducts.push(row.product_ref);
      openedQuantities.push(row.remainder!);
    } else if (outcome === 'update_remainder') {
      updatedIds.push(row.need_id!);
      updatedQuantities.push(row.remainder!);
    } else if (outcome === 'reopen') {
      reopenedIds.push(row.need_id!);
      reopenedQuantities.push(row.remainder!);
    } else if (outcome === 'close') {
      closedIds.push(row.need_id!);
      retiredRefs.push(row.source_ref);
    }
    // An alert is the open-shortage signal for a source reference. It is raised idempotently while a
    // proven shortage stands, including on the passes that change nothing, and retired when a fresh
    // observation disproves it; a later shortage opens a genuinely new episode under the same
    // reference, which is the episode model docs/alerting.md already describes.
    if (reason === null && row.usable && shortfallSign === 1) raisedRefs.push(row.source_ref);
  }

  if (heldIds.length > 0) {
    await client.query(`UPDATE need n SET hold_reason = x.reason
        FROM unnest($1::uuid[], $2::text[]) AS x(id, reason)
       WHERE n.id = x.id AND n.hold_reason IS DISTINCT FROM x.reason`, [heldIds, heldReasons]);
  }
  if (clearedIds.length > 0) {
    await client.query(`UPDATE need SET hold_reason = NULL
       WHERE id = ANY($1::uuid[]) AND hold_reason IS NOT NULL`, [clearedIds]);
  }
  if (openedRefs.length > 0) {
    // A need that appeared between the lock and here belongs to whoever wrote it; this pass does not
    // overwrite it, and the next recalculation reconciles it normally.
    await client.query(`INSERT INTO need(organisation_id, branch_id, product_ref, requested_quantity, source_ref)
       SELECT $1::uuid, $2::uuid, x.product_ref, x.quantity::numeric, x.source_ref
         FROM unnest($3::text[], $4::text[], $5::text[]) AS x(product_ref, quantity, source_ref)
       ON CONFLICT (organisation_id, source_ref) DO NOTHING`,
    [organisationId, branchId, openedProducts, openedQuantities, openedRefs]);
  }
  if (updatedIds.length > 0) {
    await client.query(`UPDATE need n SET requested_quantity = x.quantity::numeric, version = n.version + 1
        FROM unnest($1::uuid[], $2::text[]) AS x(id, quantity)
       WHERE n.id = x.id AND n.status = 'open'
         AND n.requested_quantity IS DISTINCT FROM x.quantity::numeric`, [updatedIds, updatedQuantities]);
  }
  if (reopenedIds.length > 0) {
    await client.query(`UPDATE need n SET status = 'open', requested_quantity = x.quantity::numeric,
             version = n.version + 1
        FROM unnest($1::uuid[], $2::text[]) AS x(id, quantity)
       WHERE n.id = x.id AND n.status IN ('covered', 'closed')`, [reopenedIds, reopenedQuantities]);
  }
  if (closedIds.length > 0) {
    await client.query(`UPDATE need SET status = 'closed', version = version + 1
       WHERE id = ANY($1::uuid[]) AND status = 'open'`, [closedIds]);
  }
  if (raisedRefs.length > 0) {
    await client.query(`INSERT INTO inventory_alert(organisation_id, branch_id, source_ref)
       SELECT $1::uuid, $2::uuid, ref FROM unnest($3::text[]) AS ref
       ON CONFLICT (organisation_id, source_ref) DO NOTHING`, [organisationId, branchId, raisedRefs]);
  }
  if (retiredRefs.length > 0) {
    await client.query(`DELETE FROM inventory_alert
       WHERE organisation_id = $1::uuid AND source_ref = ANY($2::text[])`, [organisationId, retiredRefs]);
  }
}
