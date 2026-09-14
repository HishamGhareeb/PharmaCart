import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareCanonicalUuids,
  decideCanonicalUuid,
  decideCommitment,
  decideNeedOutcome,
  isReceiptInclusionProven,
  readNeedHold,
  reconcileInventoryNeeds,
  reconciliationRequiredCode,
  resolveHold,
  unresolvedIntentStates,
} from '../src/need-reconciliation.ts';
import { ProcurementError, approveQuote, createQuote } from '../src/procurement.ts';
import type { RuntimeClient, TenantContext } from '../src/runtime.ts';
// BEGIN database-only imports
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { FakeSupplier } from '../../supplier/src/fake.ts';
import { IntentWorker, confirmReceipt } from '../src/orders.ts';
import { withTransaction } from '../src/runtime.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { ids, resetDatabase, sql } from './support.ts';
// END database-only imports

// Three kinds of test live here and they are named apart on purpose.
//
// `policy:` tests are pure. They pin the decisions the reconciliation SQL mirrors — which intent state
// contributes which quantity, when a commitment must be held rather than guessed, and what a need row may
// become — and they run without a database.
//
// `guard:` tests are pure as well. They drive the exported functions against a scripted client that records
// every statement, so they can prove that an identifier is refused by name before any query or lock runs.
//
// `database:` tests are the real evidence. They stage synthetic installations, targets, projections,
// approvals, acknowledgements and receipts in PostgreSQL. Builders do not run them; the coordinator runs
// them serially against pharmacart_test. No acceptance criterion may move on the pure tests alone. See
// docs/testing/need-reconciliation.md.

test('policy: an intent state decides how its quantity is counted and an unmodelled state is never guessed', () => {
  const proven = { unitMatchesTarget: true, hasOrderLine: true, hasReadableQuotedQuantity: true };
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'queued' }),
    { kind: 'count', basis: 'quoted_ordered' });
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'acknowledged' }),
    { kind: 'count', basis: 'accepted_not_received' });
  // A rejected order is settled, not committed: leaving it counted would silently under-order forever.
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'rejected' }), { kind: 'settled' });
  for (const state of ['submitting', 'outcome_unknown', 'human_review']) {
    assert.deepEqual(decideCommitment({ ...proven, intentState: state }),
      { kind: 'hold', reason: 'unknown_order_state' }, state);
  }
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'invented_future_state' }),
    { kind: 'hold', reason: 'unverified_commitment' });
  assert.deepEqual([...unresolvedIntentStates].sort(), ['human_review', 'outcome_unknown', 'submitting']);
});

test('policy: a commitment whose unit, lineage or quantity cannot be proven holds instead of counting', () => {
  const proven = { unitMatchesTarget: true, hasOrderLine: true, hasReadableQuotedQuantity: true };
  // Converting between a target in boxes and a commitment in strips would change how much gets bought.
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'queued', unitMatchesTarget: false }),
    { kind: 'hold', reason: 'commitment_unit_mismatch' });
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'acknowledged', unitMatchesTarget: false }),
    { kind: 'hold', reason: 'commitment_unit_mismatch' });
  // A settled order carries no quantity into the comparison, so its unit cannot matter.
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'rejected', unitMatchesTarget: false }),
    { kind: 'settled' });
  // An acknowledgement without its order line has no accepted or received quantity to read.
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'acknowledged', hasOrderLine: false }),
    { kind: 'hold', reason: 'unverified_commitment' });
  // A queued intent has no order line until a worker claims it, so the quoted quantity carries it.
  assert.deepEqual(decideCommitment({ ...proven, intentState: 'queued', hasOrderLine: false }),
    { kind: 'count', basis: 'quoted_ordered' });
  assert.deepEqual(
    decideCommitment({ intentState: 'queued', unitMatchesTarget: true, hasOrderLine: false, hasReadableQuotedQuantity: false }),
    { kind: 'hold', reason: 'unverified_commitment' });
});

test('policy: a live unresolved order outranks a cached hold flag and a clean read clears nothing it did not prove', () => {
  const clean = { storedReason: null, unresolvedOrder: false, receiptInclusionUnproven: false, unattributableCommitment: false } as const;
  assert.equal(resolveHold(clean), null);
  // The order became unknown after the last feed: the cached flag is stale, the live state is not.
  assert.equal(resolveHold({ ...clean, unresolvedOrder: true }), 'unknown_order_state');
  assert.equal(resolveHold({ ...clean, receiptInclusionUnproven: true }), 'receipt_inclusion_unproven');
  assert.equal(resolveHold({ ...clean, unresolvedOrder: true, receiptInclusionUnproven: true }), 'unknown_order_state');
  // Reasons only reconciliation can see survive a clean live read.
  assert.equal(resolveHold({ ...clean, storedReason: 'commitment_unit_mismatch' }), 'commitment_unit_mismatch');
  assert.equal(resolveHold({ ...clean, storedReason: 'unverified_commitment', unresolvedOrder: true }), 'unknown_order_state');
});

test('policy: a live commitment that names no provable need holds as unverified without outranking a stronger reason', () => {
  const clean = { storedReason: null, unresolvedOrder: false, receiptInclusionUnproven: false, unattributableCommitment: false } as const;
  // The last recalculation saw nothing wrong, but a live order line now names no need that can be proven.
  assert.equal(resolveHold({ ...clean, unattributableCommitment: true }), 'unverified_commitment');
  assert.equal(resolveHold({ ...clean, unattributableCommitment: true, storedReason: 'commitment_unit_mismatch' }),
    'commitment_unit_mismatch');
  assert.equal(resolveHold({ ...clean, unattributableCommitment: true, receiptInclusionUnproven: true }),
    'receipt_inclusion_unproven');
  assert.equal(resolveHold({ ...clean, unattributableCommitment: true, unresolvedOrder: true }), 'unknown_order_state');
});

test('policy: an applied writeback is delivery evidence and never proof that a snapshot carried the receipt', () => {
  const proven = { writebackApplied: true, inclusionRecorded: true, observationAtOrAfterInclusion: true } as const;
  assert.equal(isReceiptInclusionProven(proven), true);
  // The coordinator decision this pins: 'applied' means the stock system was told, not that any export
  // since has carried the boxes back. Lifting the hold here guesses which side of that race we are on.
  assert.equal(isReceiptInclusionProven({ ...proven, inclusionRecorded: false }), false);
  // An inclusion point recorded but not yet observed is a promise, not an observation.
  assert.equal(isReceiptInclusionProven({ ...proven, observationAtOrAfterInclusion: false }), false);
  assert.equal(isReceiptInclusionProven({ ...proven, writebackApplied: false }), false);
  assert.equal(isReceiptInclusionProven({ writebackApplied: false, inclusionRecorded: false, observationAtOrAfterInclusion: false }), false);
});

test('policy: a held need or an unusable observation is preserved, never recomputed', () => {
  const open = { hasNeed: true, needStatus: 'open', observationUsable: true, remainderChanged: true } as const;
  assert.equal(decideNeedOutcome({ ...open, held: true, shortfallSign: 1 }), 'hold');
  assert.equal(decideNeedOutcome({ ...open, held: true, shortfallSign: -1 }), 'hold');
  // A hold cannot attach to a need row that does not exist yet, and it must not invent one.
  assert.equal(decideNeedOutcome({ ...open, hasNeed: false, needStatus: null, held: true, shortfallSign: 1 }), 'preserve');
  // Missing and stale observations are unknown, not zero stock.
  assert.equal(decideNeedOutcome({ ...open, held: false, observationUsable: false, shortfallSign: 1 }), 'preserve');
  assert.equal(decideNeedOutcome({ ...open, held: false, observationUsable: false, shortfallSign: -1 }), 'preserve');
  assert.equal(decideNeedOutcome({ ...open, hasNeed: false, needStatus: null, held: false, observationUsable: false, shortfallSign: 1 }),
    'preserve');
});

test('policy: a proven remainder opens, updates, reopens or closes a need and repeats without churn', () => {
  const proven = { hasNeed: true, held: false, observationUsable: true } as const;
  assert.equal(decideNeedOutcome({ ...proven, hasNeed: false, needStatus: null, shortfallSign: 1, remainderChanged: true }),
    'open_new');
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'open', shortfallSign: 1, remainderChanged: true }),
    'update_remainder');
  // The same feed twice must not bump the version that quotes are pinned to.
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'open', shortfallSign: 1, remainderChanged: false }), 'preserve');
  // A commitment that was rejected or settled leaves real demand behind again.
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'covered', shortfallSign: 1, remainderChanged: true }), 'reopen');
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'closed', shortfallSign: 1, remainderChanged: true }), 'reopen');
  // Surplus and exact coverage both retire the need; requested_quantity must stay positive.
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'open', shortfallSign: -1, remainderChanged: true }), 'close');
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'open', shortfallSign: 0, remainderChanged: true }), 'close');
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'covered', shortfallSign: 0, remainderChanged: true }), 'preserve');
  assert.equal(decideNeedOutcome({ ...proven, hasNeed: false, needStatus: null, shortfallSign: -1, remainderChanged: true }),
    'preserve');
  // Nothing here quietly rewrites a need that a quote is already sitting on.
  assert.equal(decideNeedOutcome({ ...proven, needStatus: 'quoted', shortfallSign: 1, remainderChanged: true }), 'preserve');
});

// ---------------------------------------------------------------------------------------------------------
// Identifier guards. Every identifier below would reach a SQL parameter, a row lock or a lock-order
// comparison. PostgreSQL accepts upper case, braces and missing hyphens when it casts text to uuid, and raises
// 22P02 for anything else, which aborts the caller's transaction instead of naming the problem. So each one is
// refused by name before the first statement, and the scripted client proves no statement ran.

const syntheticOrganisation = '1a000000-0000-4000-8000-00000000000a';
const syntheticBranch = '2b000000-0000-4000-8000-00000000000b';
const syntheticInstallation = '5e000000-0000-4000-8000-00000000000e';
const syntheticNeed = '4d000000-0000-4000-8000-00000000000d';
const syntheticQuote = '3c000000-0000-4000-8000-00000000000c';

/** Spellings of a UUID that must never reach SQL, each paired with the reason it is refused. */
const refusedSpellings = (canonical: string): ReadonlyArray<readonly [string, unknown]> => [
  ['malformed', 'not-a-uuid'],
  ['malformed', ''],
  ['malformed', canonical.slice(0, -1)],
  ['malformed', ` ${canonical}`],
  ['malformed', `${canonical}' OR '1'='1`],
  ['non_canonical', canonical.toUpperCase()],
  ['non_canonical', `{${canonical}}`],
  ['non_canonical', canonical.replaceAll('-', '')],
  ['nil', '00000000-0000-0000-0000-000000000000'],
  ['not_a_string', undefined],
  ['not_a_string', 42],
];

test('policy: an identifier is canonical only as a lowercase hyphenated non-nil UUID, and every other spelling is refused by reason', () => {
  assert.deepEqual(decideCanonicalUuid(syntheticNeed), { kind: 'canonical', value: syntheticNeed });
  // Version and variant nibbles are not policed, matching the API selector and the contract pattern.
  assert.deepEqual(decideCanonicalUuid('ffffffff-ffff-ffff-ffff-ffffffffffff'),
    { kind: 'canonical', value: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
  for (const [reason, spelling] of refusedSpellings(syntheticNeed)) {
    assert.deepEqual(decideCanonicalUuid(spelling), { kind: 'refused', reason }, String(spelling));
  }
  // A spelling PostgreSQL would accept is still refused: it is the one that splits a Set and a lock order.
  assert.deepEqual(decideCanonicalUuid('4d00-0000-0000-4000-8000-0000-0000-000d'), { kind: 'refused', reason: 'non_canonical' });
});

test('policy: canonical identifiers compare in the byte order of the uuid type, independent of locale', () => {
  const shuffled = [
    'ffffffff-0000-4000-8000-000000000000', '00000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000000',
    '00000000-0000-4000-8000-000000000009', '9fffffff-ffff-4fff-bfff-ffffffffffff', '0a000000-0000-4000-8000-000000000000',
  ];
  const byBytes = [...shuffled].sort((a, b) =>
    Buffer.compare(Buffer.from(a.replaceAll('-', ''), 'hex'), Buffer.from(b.replaceAll('-', ''), 'hex')));
  assert.deepEqual([...shuffled].sort(compareCanonicalUuids), byBytes);
  assert.equal(compareCanonicalUuids(syntheticNeed, syntheticNeed), 0);
});

type RecordedStatement = { text: string; values: readonly unknown[] };
type ScriptedRows = { rows: Record<string, unknown>[]; rowCount?: number };

/** A client that records every statement and answers from a script. The default answers nothing. */
function scriptedClient(script: (text: string, values: readonly unknown[]) => ScriptedRows = () => ({ rows: [] })) {
  const statements: RecordedStatement[] = [];
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      const answer = script(text, values);
      return { rows: answer.rows, rowCount: answer.rowCount ?? answer.rows.length };
    },
  };
  return { client: client as unknown as RuntimeClient, statements };
}

const purchaser: TenantContext = {
  principalKind: 'member',
  userSubject: 'synthetic:user:guard',
  membershipId: '3a000000-0000-4000-8000-00000000003a',
  organisationId: syntheticOrganisation,
  organisationKind: 'pharmacy',
  branchId: syntheticBranch,
  allowedBranchIds: [syntheticBranch],
  role: 'pharmacy_owner',
  membershipVersion: 1,
};

/** A reconciliation refusal names the identifier and the reason, whatever class carries it. */
const refusedIdentifier = (field: string, reason: string) => (error: unknown) => {
  assert.ok(error instanceof Error, 'a refusal is an Error');
  assert.deepEqual((error as { refusal?: unknown }).refusal, { kind: 'invalid_identifier', field, reason });
  return true;
};

/** A procurement refusal keeps its HTTP status and code and carries the named identifier as detail. */
const refusedProcurement = (status: number, code: string, field: string, reason: string) => (error: unknown) => {
  assert.ok(error instanceof ProcurementError, 'a procurement refusal is a ProcurementError');
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.deepEqual((error as { detail?: unknown }).detail, { field, reason });
  return true;
};

test('guard: reconciliation refuses an installation identifier that is not a canonical UUID before any query or lock', async () => {
  for (const [reason, spelling] of refusedSpellings(syntheticInstallation)) {
    const { client, statements } = scriptedClient();
    await assert.rejects(reconcileInventoryNeeds(client, spelling as string),
      refusedIdentifier('installationId', reason), `${reason}: ${String(spelling)}`);
    assert.deepEqual(statements, [], `no statement or row lock may run for ${String(spelling)}`);
  }
});

test('guard: a hold read refuses a need identifier that is not a canonical UUID before any query', async () => {
  for (const [reason, spelling] of refusedSpellings(syntheticNeed)) {
    const { client, statements } = scriptedClient();
    // Returning "no hold" here would tell quoting and approval that the remainder is proven.
    await assert.rejects(readNeedHold(client, spelling as string),
      refusedIdentifier('needId', reason), `${reason}: ${String(spelling)}`);
    assert.deepEqual(statements, [], `no statement may run for ${String(spelling)}`);
  }
});

test('guard: a hold read for a need it cannot see refuses by name instead of reporting a proven remainder', async () => {
  const { client, statements } = scriptedClient();
  await assert.rejects(readNeedHold(client, syntheticNeed), (error: unknown) => {
    assert.deepEqual((error as { refusal?: unknown }).refusal, { kind: 'need_not_visible', needId: syntheticNeed });
    return true;
  });
  assert.equal(statements.length, 1, 'exactly one read, and nothing written');
  assert.deepEqual(statements[0]!.values[0], syntheticNeed);
});

test('guard: quoting refuses a need identifier that is not a canonical UUID before it is read or persisted', async () => {
  for (const [reason, spelling] of refusedSpellings(syntheticNeed)) {
    const { client, statements } = scriptedClient();
    await assert.rejects(createQuote(client, purchaser, {
      branchId: syntheticBranch,
      lines: [{ needId: spelling as string, needVersion: 1, quantity: '1', unit: 'box' }],
      constraints: { supplierIds: [], paymentTerm: 'cash' },
    }), refusedProcurement(422, 'INVALID_IDENTIFIER', 'lines[0].needId', reason), `${reason}: ${String(spelling)}`);
    assert.deepEqual(statements, [], `nothing may be read or written for ${String(spelling)}`);
  }
});

test('guard: two spellings of one need cannot pass the duplicate check as two needs', async () => {
  // Before the guard, the Set comparison saw two strings, PostgreSQL saw one row, and the quote persisted both.
  const { client, statements } = scriptedClient();
  await assert.rejects(createQuote(client, purchaser, {
    branchId: syntheticBranch,
    lines: [
      { needId: syntheticNeed, needVersion: 1, quantity: '1', unit: 'box' },
      { needId: syntheticNeed.toUpperCase(), needVersion: 1, quantity: '1', unit: 'box' },
    ],
    constraints: { supplierIds: [], paymentTerm: 'cash' },
  }), refusedProcurement(422, 'INVALID_IDENTIFIER', 'lines[1].needId', 'non_canonical'));
  assert.deepEqual(statements, []);
});

test('guard: approval refuses a quote identifier that is not a canonical UUID before any lock', async () => {
  for (const [reason, spelling] of refusedSpellings(syntheticQuote)) {
    const { client, statements } = scriptedClient();
    await assert.rejects(approveQuote(client, purchaser, spelling as string, 1, 'guard-key'),
      refusedProcurement(422, 'INVALID_IDENTIFIER', 'quoteId', reason), `${reason}: ${String(spelling)}`);
    assert.deepEqual(statements, [], `no advisory lock, replay read or quote lock may run for ${String(spelling)}`);
  }
});

/** A pending quote as approval reads it back, with one line per need. Identifiers come from the stored row. */
function pendingQuote(lines: ReadonlyArray<{ needId: unknown; supplierId?: unknown; offerId?: unknown }>) {
  return {
    id: syntheticQuote, version: 1, status: 'quoted', fresh: true, total: '1', currency: 'EGP',
    lines: lines.map((line, index) => ({
      needId: line.needId, needVersion: 1, quantity: '1', unit: 'box',
      mapId: '7a000000-0000-4000-8000-00000000007a', mapVersion: 1,
      productId: '6a000000-0000-4000-8000-00000000006a', identity: {},
      // `in`, not `??`: an explicitly undefined identifier is one of the spellings under test.
      offerId: 'offerId' in line ? line.offerId : `9a000000-0000-4000-8000-00000000009${index}`, offerVersion: 1, termsVersion: 1,
      supplierId: 'supplierId' in line ? line.supplierId : '1c000000-0000-4000-8000-00000000001c',
      gross: '1', discount: '0', tax: '0', fees: '0', net: '1',
    })),
  };
}

/** Answers approval's statements up to the budget reservation, which it then refuses to stop the attempt. */
function approvalScript(quote: ReturnType<typeof pendingQuote>) {
  return (text: string): ScriptedRows => {
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (text.includes('FROM command_result')) return { rows: [] };
    if (text.includes('FROM quote WHERE id=$1 FOR UPDATE')) return { rows: [quote] };
    if (text.includes('FOR UPDATE OF n')) {
      return { rows: [{
        offer_version: 1, terms_version: 1, relationship_terms: 1, relationship_status: 'active', fresh: true,
        need_version: 1, need_status: 'open', map_version: 1, map_status: 'verified', product_status: 'verified',
        verification_status: 'verified', available: true, need_covers: true,
      }] };
    }
    if (text.includes('hold_reason')) {
      return { rows: [{ hold_reason: null, unresolved_order: false, pending_receipt: false, unattributable_commitment: false }] };
    }
    if (text.includes('to_char(now()')) return { rows: [{ period: '2026-09' }] };
    if (text.includes('UPDATE budget')) return { rows: [], rowCount: 0 };
    throw new Error(`unscripted statement: ${text.slice(0, 80)}`);
  };
}

test('guard: approval refuses a stored line identifier that is not a canonical UUID before any need lock', async () => {
  const fields = ['needId', 'supplierId', 'offerId'] as const;
  for (const field of fields) {
    for (const [reason, spelling] of refusedSpellings(syntheticNeed)) {
      const quote = pendingQuote([{ needId: syntheticNeed, [field]: spelling }]);
      const { client, statements } = scriptedClient(approvalScript(quote));
      // The stored quote cannot be approved as written; a fresh quote from canonical input is the remedy.
      await assert.rejects(approveQuote(client, purchaser, syntheticQuote, 1, 'guard-key'),
        refusedProcurement(409, 'REQUOTE_REQUIRED', `lines[0].${field}`, reason), `${field} ${reason}: ${String(spelling)}`);
      assert.equal(statements.some((statement) => statement.text.includes('FOR UPDATE OF n')), false,
        `no need row may be locked for a stored ${field} of ${String(spelling)}`);
    }
  }
});

test('guard: approval takes need locks in the byte order PostgreSQL uses for ORDER BY id', async () => {
  // Reconciliation locks needs with ORDER BY n.id. Approval must take the same rows in the same order, or a
  // recalculation and an approval can each hold a lock the other needs.
  const needIds = [
    'f0000000-0000-4000-8000-000000000001',
    '0a000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '09000000-0000-4000-8000-000000000001',
  ];
  const quote = pendingQuote(needIds.map((needId) => ({ needId })));
  const { client, statements } = scriptedClient(approvalScript(quote));
  await assert.rejects(approveQuote(client, purchaser, syntheticQuote, 1, 'guard-key'),
    (error: unknown) => error instanceof ProcurementError && error.code === 'BUDGET_EXCEEDED');
  const lockOrder = statements.filter((statement) => statement.text.includes('FOR UPDATE OF n'))
    .map((statement) => statement.values[2]);
  const byteOrder = [...needIds].sort((a, b) =>
    Buffer.compare(Buffer.from(a.replaceAll('-', ''), 'hex'), Buffer.from(b.replaceAll('-', ''), 'hex')));
  assert.deepEqual(lockOrder, byteOrder);
});

// BEGIN database tests

const sourceRef = `${ids.installation}:00017`;
const unrelatedRef = `${ids.installation}:00019`;
const scope = { subject: 'synthetic:user:a', organisationId: ids.a, branchId: ids.branchA };

const reconciliationRequired = (error: unknown) => error instanceof ProcurementError
  && error.status === 409 && error.code === reconciliationRequiredCode;

/** Synthetic installation A: one feed source under a target of ten boxes carrying the existing open need,
 * and a second unrelated source of four boxes that must keep moving while the first one is held. */
async function arrange(t: TestContext) {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedProcurement();
  await sql(`INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status)
      VALUES('${ids.installation}','${ids.a}','${ids.branchA}','synthetic:connector:a','active');
    INSERT INTO inventory_target(installation_id,organisation_id,branch_id,source_code,product_ref,unit,target_quantity) VALUES
      ('${ids.installation}','${ids.a}','${ids.branchA}','00017','SYN-A','box',10),
      ('${ids.installation}','${ids.a}','${ids.branchA}','00019','SYN-A-UNRELATED','box',4);
    UPDATE need SET requested_quantity=10,source_ref='${sourceRef}' WHERE id='${ids.needA}';`);

  const transaction = <T>(callback: (client: RuntimeClient, context: TenantContext) => Promise<T>) =>
    withTransaction(pool, scope.subject, scope.organisationId, scope.branchId, callback);
  const value = async (text: string) => (await sql(text)).trim();
  const describe = (predicate: string) =>
    value(`SELECT status||'|'||version||'|'||requested_quantity::text||'|'||coalesce(hold_reason,'-') FROM need WHERE ${predicate}`);

  return {
    pool,
    transaction,
    value,
    /** Replaces the projection row for one source code, as a completed feed revision would. */
    feed: (sourceCode: string, quantity: string,
      options: { stale?: boolean; unit?: string; sequence?: number; snapshotId?: string } = {}) => sql(
      `INSERT INTO inventory_projection(installation_id,organisation_id,branch_id,source_code,quantity,unit,stale,snapshot_id,sequence)
       VALUES('${ids.installation}','${ids.a}','${ids.branchA}','${sourceCode}',${quantity},'${options.unit ?? 'box'}',${options.stale ?? false},'${options.snapshotId ?? `snap-${options.sequence ?? 1}`}',${options.sequence ?? 1})
       ON CONFLICT(installation_id,source_code) DO UPDATE SET quantity=EXCLUDED.quantity,unit=EXCLUDED.unit,
         stale=EXCLUDED.stale,snapshot_id=EXCLUDED.snapshot_id,sequence=EXCLUDED.sequence`),
    reconcile: () => transaction((client) => reconcileInventoryNeeds(client, ids.installation)),
    quote: (needVersion: number, quantity: string) => transaction((client, context) => createQuote(client, context, {
      branchId: ids.branchA,
      lines: [{ needId: ids.needA, needVersion, quantity, unit: 'box' }],
      constraints: { supplierIds: [], paymentTerm: 'cash' },
    })),
    approve: (quoteId: string, key: string) =>
      transaction((client, context) => approveQuote(client, context, quoteId, 1, key)),
    hold: (needId: string) => transaction((client) => readNeedHold(client, needId)),
    need: () => describe(`id='${ids.needA}'`),
    unrelated: () => describe(`source_ref='${unrelatedRef}'`),
    alerts: () => value("SELECT coalesce(string_agg(source_ref,',' ORDER BY source_ref),'-') FROM inventory_alert"),
    alertIdentities: () => value("SELECT coalesce(string_agg(id::text,',' ORDER BY id),'-') FROM inventory_alert"),
    intentId: () => value('SELECT id FROM order_intent ORDER BY id LIMIT 1'),
    /** Sessions of pharmacart_test currently waiting on a heavyweight lock. */
    lockWaiters: async () => Number(await value(
      "SELECT count(*) FROM pg_stat_activity WHERE datname='pharmacart_test' AND wait_event_type='Lock'")),
    worker: async (mode: 'accepted' | 'partial') => {
      const directory = await mkdtemp(join(tmpdir(), 'pharmacart-reconciliation-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const worker = new IntentWorker(pool, scope, new FakeSupplier(join(directory, 'ledger', 'ledger.json'), mode));
      await worker.enableSyntheticDispatch();
      return worker;
    },
  };
}

/** An approved, acknowledged two-box order against the ten-box need, with its receipt confirmed. */
async function receivedOrder(ground: Awaited<ReturnType<typeof arrange>>) {
  await ground.feed('00017', '0', { sequence: 1 });
  await ground.reconcile();
  const quote = await ground.quote(1, '2');
  await ground.approve(quote.id, 'received-order');
  const intentId = await ground.intentId();
  const worker = await ground.worker('accepted');
  assert.equal((await worker.run(intentId)).state, 'acknowledged');
  const lineId = await ground.value('SELECT id FROM order_line');
  await ground.transaction((client, context) =>
    confirmReceipt(client, context, intentId, 'receipt-under-test', [{ lineId, quantity: '2' }]));
  assert.equal(await ground.value('SELECT status FROM receipt_writeback'), 'queued');
  return { intentId, lineId };
}

/** Polls until another session is waiting on a lock, so an interleaving is observed rather than assumed. */
async function untilLockWait(ground: Awaited<ReturnType<typeof arrange>>) {
  for (let attempt = 0; ; attempt += 1) {
    if (await ground.lockWaiters() >= 1) return;
    assert(attempt < 50, 'the second transaction never queued behind the first');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('database: a partial approval survives the next stock feed instead of being restored to the ordered quantity', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|1|10|-', 'ten boxes short of a ten box target with nothing on order');
  assert.equal(await ground.alerts(), sourceRef);

  const quote = await ground.quote(1, '4');
  await ground.approve(quote.id, 'partial-approval');
  assert.equal(await ground.need(), 'open|2|6|-', 'the approval consumes exactly what it quoted');
  assert.equal(await ground.value("SELECT state FROM order_intent"), 'queued');

  // Nothing has arrived, so the feed still reports zero. The four boxes on order are a known internal
  // reservation and must be subtracted; restoring ten here is the double-order bug.
  await ground.feed('00017', '0');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|6|-', 'a queued commitment must not be re-requested');
});

test('database: an acknowledged commitment counts accepted-but-not-received and releases rejected quantity', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const quote = await ground.quote(1, '4');
  await ground.approve(quote.id, 'acknowledged-commitment');
  assert.equal(await ground.need(), 'open|2|6|-');

  // The synthetic supplier accepts one box fewer than ordered, so three are committed and one is settled.
  const worker = await ground.worker('partial');
  assert.equal((await worker.run(await ground.intentId())).state, 'acknowledged');
  assert.equal(await ground.value("SELECT accepted::text||'/'||rejected::text||'/'||received::text FROM order_line"), '3/1/0');

  await ground.feed('00017', '0');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|3|7|-',
    'the rejected box returns to the outstanding remainder and the accepted three stay committed');
});

test('database: an unknown order state holds only its own need and refuses quotes and approvals', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.feed('00019', '1');
  await ground.reconcile();
  const quote = await ground.quote(1, '2');
  await ground.approve(quote.id, 'unknown-outcome');
  assert.equal(await ground.need(), 'open|2|8|-');

  // A quote captured while the order was still sound, then the send loses its outcome.
  const standing = await ground.quote(2, '1');
  await sql(`UPDATE order_intent SET state='outcome_unknown',version=version+1`);

  // Nothing has recalculated yet, so the cached flag is still clear. The approval must consult the order.
  assert.equal(await ground.value(`SELECT coalesce(hold_reason,'-') FROM need WHERE id='${ids.needA}'`), '-');
  await assert.rejects(ground.approve(standing.id, 'held-approval'), reconciliationRequired);
  assert.equal(await ground.value('SELECT count(*) FROM approval'), '1', 'the refused approval created no order');
  assert.equal(await ground.value("SELECT count(*) FROM command_result WHERE key='held-approval'"), '0');

  await ground.feed('00017', '0');
  await ground.feed('00019', '1');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|unknown_order_state',
    'an order of unknown quantity holds automatic replenishment rather than guessing');
  assert.equal(await ground.unrelated(), 'open|1|3|-', 'an unrelated need keeps being maintained');
  assert.equal(await ground.hold(ids.needA), 'unknown_order_state');

  await assert.rejects(ground.quote(2, '1'), reconciliationRequired);
});

test('database: resolving the order state clears the hold and computes the remainder from what was accepted', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const quote = await ground.quote(1, '2');
  await ground.approve(quote.id, 'resolved-outcome');

  // The order really does reach the synthetic supplier, so recovery has something to find later.
  const intentId = await ground.intentId();
  const worker = await ground.worker('accepted');
  assert.equal((await worker.run(intentId)).state, 'acknowledged');

  // Then the durable record loses the outcome, as a lost response would leave it.
  await sql(`UPDATE order_intent SET state='outcome_unknown',version=version+1`);
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|unknown_order_state');

  // Recovery finds the order in the supplier ledger and settles it, so the quantity is knowable again.
  assert.equal((await worker.reconcile(intentId)).state, 'acknowledged');
  await ground.feed('00017', '1');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|3|7|-',
    'one box on the shelf and two accepted-but-unreceived leave seven of the ten box target outstanding');
  assert.equal(await ground.hold(ids.needA), null);
  const reopened = await ground.quote(3, '1');
  assert.equal(reopened.lines.length, 1, 'a resolved need may be quoted again');
});

test('database: a receipt holds the need until a snapshot is proven to carry it, and an applied writeback is not that proof', async (t) => {
  const ground = await arrange(t);
  await receivedOrder(ground);

  // Two boxes are on the shelf but the feed cannot yet be trusted to include them. Counting them on both
  // sides under-orders and counting them on neither buys them twice, so neither reading is chosen.
  await ground.feed('00017', '2', { sequence: 2 });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven');
  assert.equal(await ground.hold(ids.needA), 'receipt_inclusion_unproven');
  await assert.rejects(ground.quote(2, '1'), reconciliationRequired);

  // Regression for the coordinator decision: an applied writeback says the stock system was told. It
  // does not say that the export which produced the next snapshot ran after that write landed, so a
  // later feed alone must not lift the hold or move the remainder.
  await sql("UPDATE receipt_writeback SET status='applied'");
  await ground.feed('00017', '2', { sequence: 3 });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven',
    'delivery of a writeback is not evidence that any snapshot since carried the receipt');
  assert.equal(await ground.hold(ids.needA), 'receipt_inclusion_unproven');
  await assert.rejects(ground.quote(2, '1'), reconciliationRequired);

  // An inclusion point recorded but not yet reached is a promise about a future snapshot.
  await sql("UPDATE receipt_writeback SET included_snapshot_id='snap-4',included_sequence=4");
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven');

  // Observing that snapshot is the positive evidence. The remainder then counts the two boxes once: as
  // stock on the shelf, no longer as an outstanding commitment.
  await ground.feed('00017', '2', { sequence: 4 });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|-',
    'ten wanted, two observed and nothing still on order leaves eight, counted neither twice nor not at all');
  assert.equal(await ground.hold(ids.needA), null);
  const resumed = await ground.quote(2, '1');
  assert.equal(resumed.lines.length, 1, 'a proven need may be quoted again');
});

test('database: an inclusion point at the recorded sequence is proven only by the snapshot it names', async (t) => {
  const ground = await arrange(t);
  await receivedOrder(ground);
  await sql("UPDATE receipt_writeback SET status='applied',included_snapshot_id='snap-3-other-export',included_sequence=3");

  // Same sequence, different snapshot identity: that observation is not the snapshot the receipt appeared in.
  await ground.feed('00017', '2', { sequence: 3, snapshotId: 'snap-3' });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven',
    'a sequence number alone does not identify the including snapshot');
  assert.equal(await ground.hold(ids.needA), 'receipt_inclusion_unproven');

  // The named snapshot proves it, and so does any fresh snapshot beyond it.
  await ground.feed('00017', '2', { sequence: 3, snapshotId: 'snap-3-other-export' });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|-');
  await sql("UPDATE receipt_writeback SET included_snapshot_id='snap-3-elsewhere'");
  await ground.feed('00017', '2', { sequence: 4, snapshotId: 'snap-4' });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|-', 'a fresh snapshot beyond the inclusion point carries the receipt');
  assert.equal(await ground.hold(ids.needA), null);
});

test('database: a receipt with no writeback record is unproven, never assumed to be in stock', async (t) => {
  const ground = await arrange(t);
  await receivedOrder(ground);
  // The receipt reduced the outstanding commitment. Without a writeback there is nothing that could ever
  // prove the boxes reached the stock system, so the need must not be recomputed as if they had.
  await sql('DELETE FROM receipt_writeback');
  await ground.feed('00017', '0', { sequence: 2 });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven');
  assert.equal(await ground.hold(ids.needA), 'receipt_inclusion_unproven');
  await assert.rejects(ground.quote(2, '1'), reconciliationRequired);
});

test('database: a receipt line that names no line of its order still holds every need of that order', async (t) => {
  const ground = await arrange(t);
  await receivedOrder(ground);
  const original = await ground.value('SELECT lines::text FROM receipt');

  // Each stored spelling below would once have been cast, joined and silently dropped, or aborted the pass.
  const spellings = [
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ];
  for (const [index, spelling] of spellings.entries()) {
    await sql(`UPDATE receipt SET lines='[{"lineId":"${spelling}","quantity":"2"}]'::jsonb`);
    await ground.feed('00017', '2', { sequence: index + 2 });
    await ground.reconcile();
    assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven', spelling);
    assert.equal(await ground.hold(ids.needA), 'receipt_inclusion_unproven', spelling);
  }
  const lineId = await ground.value('SELECT id FROM order_line');
  await sql(`UPDATE receipt SET lines='[{"lineId":"{${lineId}}","quantity":"2"}]'::jsonb`);
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|receipt_inclusion_unproven', 'a braced spelling is not a canonical line');

  // Restored, proven by an observed including snapshot, the hold lifts and the boxes are counted once.
  await sql(`UPDATE receipt SET lines='${original}'::jsonb;
    UPDATE receipt_writeback SET status='applied',included_snapshot_id='snap-9',included_sequence=9`);
  await ground.feed('00017', '2', { sequence: 9 });
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|-');
});

test('database: a stored quote line whose identifiers are not canonical holds by name instead of aborting the pass', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.feed('00019', '1');
  await ground.reconcile();
  const quote = await ground.quote(1, '2');
  await ground.approve(quote.id, 'unattributable-line');
  assert.equal(await ground.need(), 'open|2|8|-');
  assert.equal(await ground.unrelated(), 'open|1|3|-');
  const original = await ground.value('SELECT lines::text FROM quote');

  // Before the guard, the first two raised 22P02 inside reconciliation and inside every hold read of the
  // branch, and the braced spelling was cast and counted. None of them names a need this system can prove.
  const corruptions = [
    `jsonb_set(lines,'{0,needId}','"not-a-uuid"')`,
    `jsonb_set(lines,'{0,supplierId}','"00000000-0000-0000-0000-000000000000"')`,
    `jsonb_set(lines,'{0,needId}',to_jsonb('{' || (lines->0->>'needId') || '}'))`,
    `'{"needId":"not-an-array"}'::jsonb`,
  ];
  for (const corruption of corruptions) {
    await sql(`UPDATE quote SET lines=${corruption}`);
    // The live read refuses before any recalculation has cached anything.
    assert.equal(await ground.hold(ids.needA), 'unverified_commitment', corruption);
    await ground.reconcile();
    // The commitment cannot be attributed to a need, so no need of the installation can be proven.
    assert.equal(await ground.need(), 'open|2|8|unverified_commitment', corruption);
    assert.equal(await ground.unrelated(), 'open|1|3|unverified_commitment', corruption);
    await assert.rejects(ground.quote(2, '1'), reconciliationRequired, corruption);

    await sql(`UPDATE quote SET lines='${original}'::jsonb`);
    await ground.reconcile();
    assert.equal(await ground.need(), 'open|2|8|-', `restoring ${corruption} lifts the hold`);
    assert.equal(await ground.unrelated(), 'open|1|3|-');
  }
});

test('database: identifier refusals leave the transaction usable and write nothing', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const before = await ground.need();

  await ground.transaction(async (client, context) => {
    await assert.rejects(reconcileInventoryNeeds(client, `{${ids.installation}}`),
      refusedIdentifier('installationId', 'non_canonical'));
    await assert.rejects(reconcileInventoryNeeds(client, 'not-a-uuid'), refusedIdentifier('installationId', 'malformed'));
    await assert.rejects(readNeedHold(client, '00000000-0000-0000-0000-000000000000'), refusedIdentifier('needId', 'nil'));
    // Another organisation's need is invisible under row level security. "No hold" would call it proven.
    await assert.rejects(readNeedHold(client, ids.needB), (error: unknown) => {
      assert.deepEqual((error as { refusal?: unknown }).refusal, { kind: 'need_not_visible', needId: ids.needB });
      return true;
    });
    await assert.rejects(createQuote(client, context, {
      branchId: ids.branchA,
      lines: [{ needId: `{${ids.needA}}`, needVersion: 1, quantity: '1', unit: 'box' }],
      constraints: { supplierIds: [], paymentTerm: 'cash' },
    }), refusedProcurement(422, 'INVALID_IDENTIFIER', 'lines[0].needId', 'non_canonical'));
    // A 22P02 would have aborted this transaction; a refusal by name leaves it usable.
    assert.equal((await client.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one, 1);
    await reconcileInventoryNeeds(client, ids.installation);
  });
  assert.equal(await ground.need(), before);
  assert.equal(await ground.value('SELECT count(*) FROM quote'), '0', 'a refused spelling persisted no quote');
});

test('database: a recalculation holding the need locks queues an approval, which then sees the new version', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const quote = await ground.quote(1, '4');

  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  await ground.feed('00017', '1');
  const recalculation = ground.transaction(async (client) => {
    await reconcileInventoryNeeds(client, ids.installation);
    entered();
    await released;
  });
  await locked;

  let settled = false;
  const approval = ground.approve(quote.id, 'queued-behind-recalculation')
    .then((value) => ({ value }), (error: unknown) => ({ error }))
    .finally(() => { settled = true; });
  await untilLockWait(ground);
  assert.equal(settled, false, 'the approval waits for the need lock instead of reading around it');

  release();
  await recalculation;
  const outcome = await approval;
  // The recalculation committed a new remainder, so the quote no longer describes the need. A deadlock would
  // surface here as 40P01 instead of a named refusal.
  assert.ok('error' in outcome && outcome.error instanceof ProcurementError && outcome.error.code === 'REQUOTE_REQUIRED',
    'the queued approval re-reads the recalculated need and refuses the stale quote');
  assert.equal(await ground.need(), 'open|2|9|-');
  assert.equal(await ground.value('SELECT count(*) FROM approval'), '0');
});

test('database: an approval holding the need lock queues a recalculation, which then counts the new order', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const quote = await ground.quote(1, '4');

  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const approved = new Promise<void>((resolve) => { entered = resolve; });
  const approval = ground.transaction(async (client, context) => {
    const result = await approveQuote(client, context, quote.id, 1, 'holding-need-lock');
    entered();
    await released;
    return result;
  });
  await approved;

  let settled = false;
  const recalculation = ground.reconcile().finally(() => { settled = true; });
  await untilLockWait(ground);
  assert.equal(settled, false, 'the recalculation waits for the need lock instead of reading around it');

  release();
  assert.equal((await approval).status, 202);
  await recalculation;
  // Read after the approval committed: ten wanted, none on hand, four queued. Restoring ten is the double order.
  assert.equal(await ground.need(), 'open|2|6|-');
});

test('database: a fresh surplus closes the open need without writing a forbidden zero quantity', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  assert.equal(await ground.alerts(), sourceRef);

  await ground.feed('00017', '12');
  await ground.reconcile();
  assert.equal(await ground.need(), 'closed|2|10|-', 'the last requested quantity is frozen, not zeroed');
  assert.equal(await ground.value('SELECT count(*) FROM need WHERE requested_quantity<=0'), '0');
  assert.equal(await ground.alerts(), '-', 'a disproved shortage does not keep alerting');

  // Exact coverage retires the need for the same reason, and a later shortage reopens it.
  await ground.feed('00017', '3');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|3|7|-');
  assert.equal(await ground.alerts(), sourceRef);
});

test('database: a stale, missing or mismatched observation preserves the existing need', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const settled = await ground.need();
  assert.equal(settled, 'open|1|10|-');

  await ground.feed('00017', '9', { stale: true });
  await ground.reconcile();
  assert.equal(await ground.need(), settled, 'stock known to be out of date must not shrink a need');

  await sql(`DELETE FROM inventory_projection WHERE source_code='00017'`);
  await ground.reconcile();
  assert.equal(await ground.need(), settled, 'an absent observation is unknown, not empty');

  await ground.feed('00017', '9', { unit: 'strip' });
  await ground.reconcile();
  assert.equal(await ground.need(), settled, 'a target in boxes cannot be compared against strips');
  assert.equal(await ground.unrelated(), '', 'no observation may invent a need');
});

test('database: repeated reconciliation of an unchanged position changes no version and no alert', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '3');
  await ground.feed('00019', '1');
  await ground.reconcile();
  const need = await ground.need();
  const unrelated = await ground.unrelated();
  const alerts = await ground.alertIdentities();
  assert.equal(need, 'open|2|7|-');
  assert.equal(unrelated, 'open|1|3|-');

  for (let pass = 0; pass < 3; pass += 1) await ground.reconcile();
  assert.equal(await ground.need(), need, 'an unchanged position must not bump the version quotes are pinned to');
  assert.equal(await ground.unrelated(), unrelated);
  assert.equal(await ground.alertIdentities(), alerts, 'an open alert episode keeps its identity');
});

test('database: an approved quote replay still returns its recorded result while the need is held', async (t) => {
  const ground = await arrange(t);
  await ground.feed('00017', '0');
  await ground.reconcile();
  const quote = await ground.quote(1, '2');
  const approved = await ground.approve(quote.id, 'replayed-approval');
  assert.equal(approved.status, 202);

  await sql(`UPDATE order_intent SET state='human_review',version=version+1`);
  await ground.feed('00017', '0');
  await ground.reconcile();
  assert.equal(await ground.need(), 'open|2|8|unknown_order_state');

  // The order already exists. Replaying its key must return the recorded result rather than refuse it or
  // create a second order, and the approved snapshot must be left exactly as it was.
  const replay = await ground.approve(quote.id, 'replayed-approval');
  assert.deepEqual(replay, approved);
  assert.equal(await ground.value('SELECT count(*) FROM approval'), '1');
  assert.equal(await ground.value('SELECT count(*) FROM order_intent'), '1');
  assert.equal(await ground.value('SELECT status FROM quote'), 'approved');
  assert.equal(await ground.need(), 'open|2|8|unknown_order_state');
});
