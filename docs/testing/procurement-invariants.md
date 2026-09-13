# Procurement invariants: partial coverage and organisation-scoped idempotency keys

Date: 2026-09-12. Branch `claude/procurement-invariants`, isolated worktree, synthetic data only.
Scope: `packages/db/src/procurement.ts`, new `packages/db/test/procurement-invariants.test.ts`,
new `packages/db/migrations/0012_procurement_invariants.sql` (comments only), this report.

No acceptance criterion moves to PASS from this work. AC-005 and AC-007 remain NOT RUN.

## 1. Defect 1: approval covered a whole need regardless of the quoted quantity

`createQuote` accepted any quantity up to the need's `requested_quantity`, but `approveQuote` ran
`UPDATE need SET status='covered',version=version+1` for every quote line. Approving one box of a
two-box need therefore closed the need, and the second box was silently lost.

### Fix and stored meaning

`need.requested_quantity` is the **outstanding quantity still to procure while `status='open'`**.
That is already the meaning the feed writes: `ingestInventory` recomputes it as `target - on hand`
on every projection revision (`packages/db/src/inventory.ts:33`). Approval now consumes exactly the
quantity it quoted:

```sql
UPDATE need SET
  requested_quantity=CASE WHEN requested_quantity>$2::numeric THEN requested_quantity-$2::numeric ELSE requested_quantity END,
  status=CASE WHEN requested_quantity>$2::numeric THEN 'open' ELSE 'covered' END,version=version+1
WHERE id=$1 AND status='open' AND requested_quantity>=$2::numeric
```

- A positive remainder stays `open` with `version` incremented by exactly one, which invalidates every
  competing quote that captured the earlier version.
- An exactly covered need becomes `covered`. `requested_quantity` is **not** set to zero, because
  `0001_identity_and_tenant_isolation.sql:60` enforces `CHECK (requested_quantity > 0)`. The column
  keeps the quantity of the final covered tranche and outstanding demand is read from `status`:
  `requested_quantity` when open, zero when covered or closed. `0012_procurement_invariants.sql`
  records that meaning with `COMMENT ON COLUMN`.
- The statement is its own last-resort guard: `WHERE status='open' AND requested_quantity>=$2` plus a
  `rowCount!==1` check refuses with `409 REQUOTE_REQUIRED`, and the surviving `requested_quantity > 0`
  constraint would reject an over-subtraction at the database level.
- All arithmetic is PostgreSQL `numeric`. Quantities never leave TypeScript as anything but canonical
  decimal strings; no IEEE-754 value is involved and no unit conversion was introduced.

Revalidation under the existing `FOR UPDATE OF n` lock now also rechecks quantity
(`n.requested_quantity>=$2::numeric AS need_covers`), not only `need.version`, so a remainder that
shrank without a version change is refused before any mutation.

`createQuote` compares the requested quantity against the outstanding remainder explicitly and refuses
with `422 QUANTITY_EXCEEDS_NEED`. Previously an over-request fell through the offer query and was
reported as `NO_BINDING_OFFER`, which named the wrong cause.

Idempotent replay is unchanged and cannot subtract twice: the stored `command_result` read returns
before any mutation, and the already-approved branch (`quote.status==='approved'`, HTTP 200) never
reaches the settlement statement.

Partial quotes were implemented; the contained `422` refusal fallback described in the task was **not**
needed, because the existing schema expresses a remainder without change.

## 2. Defect 2: an idempotency key reused by another branch of the same organisation

`command_result` has primary key `(organisation_id, operation, key)` while its RLS policy restricts
visibility to the current branch. A key first used by branch A is invisible to branch B's replay read,
so branch B ran the whole approval and then hit a unique violation, surfaced as an unhandled 500.

The final insert is now atomic and explicit:

```sql
INSERT INTO command_result(...) VALUES(...) ON CONFLICT DO NOTHING
```

`rowCount!==1` raises `409 IDEMPOTENCY_KEY_SCOPE_CONFLICT`. `ON CONFLICT DO NOTHING` detects the
conflict at the index, never reads the hidden row, and never applies a `DO UPDATE` visibility check, so
no other branch's data is read, returned or overwritten and RLS is not weakened. No security-definer
function was needed. The refusal is raised inside the approval transaction, so `withTransaction`
rolls back the budget reservation, approval, intents, outbox rows and need settlement of the refused
attempt. The error body carries only `code`, `message` and `correlationId`.

The pre-existing organisation-wide advisory lock `pg_advisory_xact_lock(hash(org:approve:key))` is
respected and untouched; it serialises same-key attempts across branches so the conflict is decided
deterministically rather than by two blind concurrent inserts.

Canonical same-branch replay is unchanged: same key and same request hash still return the stored
status and body; same key with a different hash still returns `409 IDEMPOTENCY_KEY_REUSED`.

## 3. Budget failure atomicity (review only, no policy change)

Reviewed as requested, nothing broadened:

- The reservation is a single conditional statement,
  `UPDATE budget SET reserved_amount=reserved_amount+$4 WHERE ... AND reserved_amount+spent_amount+$4<=limit_amount`.
  It takes a row lock, evaluates the limit and writes in one step, so two concurrent approvals cannot
  both pass the limit check. `0010_budget_settlement.sql` adds
  `CHECK(reserved_amount+spent_amount<=limit_amount)` as a database backstop.
- On refusal it matches zero rows, writes nothing and throws `409 BUDGET_EXCEEDED`; the transaction
  rolls back, so there is no reservation to release and no partial approval.
- The reservation happens before the approval, intent and outbox inserts and before the idempotency
  record, so any later refusal (including the new key-scope conflict) unwinds it with the transaction.

Two observations recorded, deliberately **not** changed because they are business policy or contract
decisions: `BUDGET_EXCEEDED` also fires when no `budget` row exists for the branch, currency and
period at all, conflating "no budget configured" with "limit exceeded"; and the period is derived from
`now() AT TIME ZONE 'UTC'` rather than the branch time zone, which acceptance-plan open decision 4
still owes an answer.

## 4. Evidence

### 4.1 Non-database checks actually run

```
npm ci                    -> added 214 packages, found 0 vulnerabilities
npm run typecheck         -> tsc --noEmit, no output, exit 0
npm run lint              -> eslint ., no output, exit 0
npm run contracts:verify  -> contracts verified
npm test                  -> tests 324 | pass 324 | fail 0   (non-database suites only)
```

`npm test` does not include `packages/db`. The database suites were not run: this worktree must not
run Docker, migrations or `pharmacart_test`.

### 4.2 Control-flow RED/GREEN (independent, no database)

Because the PostgreSQL tests cannot run here, the refusal paths were driven through a scratch harness
that records every statement `approveQuote`/`createQuote` issue and feeds back controlled results. It
is kept **outside** the worktree at
`C:\Users\Ghareeb\AppData\Local\Temp\pharmacart-procurement-red\harness.test.mjs` and is reproduced in
section 4.4 so a reviewer can rerun it. It executes no SQL and proves control flow only.

Command: `node --experimental-strip-types --test <harness path>`

RED, against the implementation before the fix:

```
✖ RED 1: an approval whose need could not be settled must refuse instead of silently covering it
✖ RED 2: the need settlement statement must carry the approved quantity
    actual   [ '22222222-2222-4222-8222-222222222222' ]
    expected [ '22222222-2222-4222-8222-222222222222', '1' ]
✖ RED 3: an idempotency key already held by another branch must be refused, not overwritten
    expected a ProcurementError, received undefined
✖ RED 4: a need that no longer covers the quoted quantity under lock must refuse before any mutation
    expected a ProcurementError, received undefined
✖ RED 5: a quote may not request more than the outstanding need
    expected a ProcurementError, received undefined
✔ GUARD 1: a stored idempotent replay performs no mutation at all
✔ GUARD 2: a second key for an already approved quote never settles the need again
```

GREEN, after the fix, same command and same file:

```
✔ RED 1 ... ✔ RED 2 ... ✔ RED 3 ... ✔ RED 4 ... ✔ RED 5 ...
✔ GUARD 1 ... ✔ GUARD 2 ...
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

The two GUARD cases passed before and after; they are regression guards on idempotent replay, not
evidence of a fix.

### 4.3 PostgreSQL and API tests: RED/GREEN awaits the coordinator

`packages/db/test/procurement-invariants.test.ts` was written before the implementation and is picked
up automatically by the existing `test:integration` and `test:coverage` globs. It was **not executed
here** and neither RED nor GREEN is claimed for it. It needs a coordinator-serialised
`pharmacart_test` run after `0012_procurement_invariants.sql` is reviewed. It asserts, over real
PostgreSQL through the authenticated Fastify API and a real local OIDC token:

1. a quote for one of two boxes approves, leaves `need` at `open|version 2|quantity 1`, and reserves
   only `12.35`;
2. two concurrent approvals of quotes that captured the same need version produce exactly one `202`
   and one `409 REQUOTE_REQUIRED`;
3. replaying the winning key returns the identical stored body and leaves the need untouched;
4. a new quote may request the remainder but not more (`422 QUANTITY_EXCEEDS_NEED`);
5. a remainder shrunk without a version change is refused under the lock with no approval and no
   stored command result;
6. covering the remainder yields `covered|version 3|quantity 1`, never a zero quantity, with two
   approvals, two intents and `reserved_amount = 24.70`;
7. the same idempotency key used by a second authorised branch of the same organisation returns `409
   IDEMPOTENCY_KEY_SCOPE_CONFLICT`, not 500, with a body that contains none of the other branch's
   approval id, quote id or `pc-syn-` reference;
8. after that refusal, approval, reservation, intent, command-result and outbox counts are unchanged,
   the second branch's budget is still `0`, its need still `open|1` and its quote still `quoted`;
9. the first branch's canonical replay is byte-identical to its original response, and the second
   branch can still approve under a key of its own.

The behaviour the integration run must confirm, and which the harness cannot: that
`INSERT ... ON CONFLICT DO NOTHING` silently skips a row hidden by the RLS policy instead of raising,
and that `SELECT ... FOR UPDATE OF n` re-reads the committed need version after waiting for the lock.

### 4.4 Harness source

```js
// Scratch control-flow harness kept OUTSIDE the repository worktree.
// It does not execute SQL. It records the statements approveQuote/createQuote issue and the
// results they act on, so the refusal paths can be exercised without a database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { approveQuote, createQuote, ProcurementError } =
  await import(pathToFileURL('<worktree>/packages/db/src/procurement.ts').href);

const QUOTE = '11111111-1111-4111-8111-111111111111';
const NEED = '22222222-2222-4222-8222-222222222222';
const OFFER = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';

const context = {
  principalKind: 'member', userSubject: 'synthetic:user:a',
  membershipId: '55555555-5555-4555-8555-555555555555',
  organisationId: '66666666-6666-4666-8666-666666666666',
  organisationKind: 'pharmacy', branchId: '77777777-7777-4777-8777-777777777777',
  allowedBranchIds: ['77777777-7777-4777-8777-777777777777'],
  role: 'pharmacy_owner', membershipVersion: 1,
};

const line = { needId: NEED, needVersion: 1, quantity: '1', unit: 'box', mapId: OFFER, mapVersion: 1,
  productId: OFFER, identity: { saleUnit: 'box' }, offerId: OFFER, offerVersion: 1, termsVersion: 1,
  supplierId: SUPPLIER, gross: '12.35', discount: '0', tax: '0', fees: '0', net: '12.35' };

const revalidation = { offer_version: 1, terms_version: 1, relationship_terms: 1, relationship_status: 'active',
  fresh: true, need_version: 1, need_status: 'open', map_version: 1, map_status: 'verified',
  product_status: 'verified', verification_status: 'verified', available: true, need_covers: true };

function client(options = {}) {
  const calls = [];
  const route = (text) => {
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (text.includes('FROM command_result')) return { rows: options.replay ? [options.replay] : [], rowCount: options.replay ? 1 : 0 };
    if (text.includes('INSERT INTO command_result')) return { rows: [], rowCount: options.commandResultRows ?? 1 };
    if (text.includes('FROM quote WHERE id')) return { rows: [{ id: QUOTE, version: 1, status: options.quoteStatus ?? 'quoted', fresh: true, total: '12.35', currency: 'EGP', lines: [line] }], rowCount: 1 };
    if (text.includes('FROM approval WHERE quote_id')) return { rows: [{ id: 'existing-approval' }], rowCount: 1 };
    if (text.includes('FROM order_intent WHERE quote_id')) return { rows: [{ id: 'existing-intent' }], rowCount: 1 };
    if (text.includes('FROM need n LEFT JOIN')) return { rows: [{ id: NEED, status: 'open', version: 1, requested_quantity: '2',
      within_need: options.withinNeed ?? true, map_id: OFFER, map_status: 'verified', map_version: 1,
      product_id: OFFER, identity: { saleUnit: 'box' }, product_status: 'verified' }], rowCount: 1 };
    if (text.includes('round(o.unit_price')) return { rows: [{ id: OFFER, version: 1, terms_version: 1, supplier_id: SUPPLIER, net: '12.35', expires_at: new Date(Date.now() + 600000).toISOString() }], rowCount: 1 };
    if (text.includes('FROM account_offer o JOIN supplier_relationship')) return { rows: [{ ...revalidation, ...options.revalidation }], rowCount: 1 };
    if (text.includes('jsonb_array_elements')) return { rows: [{ total: '12.35' }], rowCount: 1 };
    if (text.includes('to_char(now()')) return { rows: [{ period: '2026-09' }], rowCount: 1 };
    if (text.includes('UPDATE budget SET')) return { rows: [{ period: '2026-09' }], rowCount: 1 };
    if (text.includes('UPDATE need SET')) return { rows: [], rowCount: options.needRows ?? 1 };
    return { rows: [], rowCount: 1 };
  };
  return { calls, query: async (text, params = []) => { calls.push({ text, params }); return route(text); } };
}

const mutations = (calls) => calls.filter(call => /^\s*(INSERT|UPDATE|DELETE)/i.test(call.text));
async function refusal(promise) {
  const error = await promise.then(() => undefined, (caught) => caught);
  assert(error instanceof ProcurementError, `expected a ProcurementError, received ${error}`);
  return error;
}

test('RED 1: an approval whose need could not be settled must refuse instead of silently covering it', async () => {
  const fake = client({ needRows: 0 });
  const error = await refusal(approveQuote(fake, context, QUOTE, 1, 'harness-key'));
  assert.equal(error.status, 409); assert.equal(error.code, 'REQUOTE_REQUIRED');
});

test('RED 2: the need settlement statement must carry the approved quantity', async () => {
  const fake = client();
  await approveQuote(fake, context, QUOTE, 1, 'harness-key');
  const settle = fake.calls.filter(call => call.text.includes('UPDATE need SET'));
  assert.equal(settle.length, 1);
  assert.deepEqual(settle[0].params, [NEED, '1']);
  assert.doesNotMatch(settle[0].text, /SET\s+status='covered'/);
});

test('RED 3: an idempotency key already held by another branch must be refused, not overwritten', async () => {
  const fake = client({ commandResultRows: 0 });
  const error = await refusal(approveQuote(fake, context, QUOTE, 1, 'harness-key'));
  assert.equal(error.status, 409); assert.equal(error.code, 'IDEMPOTENCY_KEY_SCOPE_CONFLICT');
  assert.equal(error.message, 'IDEMPOTENCY_KEY_SCOPE_CONFLICT');
  assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /approvalId|orderIntentIds|pc-syn-/);
});

test('RED 4: a need that no longer covers the quoted quantity under lock must refuse before any mutation', async () => {
  const fake = client({ revalidation: { need_covers: false } });
  const error = await refusal(approveQuote(fake, context, QUOTE, 1, 'harness-key'));
  assert.equal(error.status, 409); assert.equal(error.code, 'REQUOTE_REQUIRED');
  assert.deepEqual(mutations(fake.calls), []);
});

test('RED 5: a quote may not request more than the outstanding need', async () => {
  const fake = client({ withinNeed: false });
  const error = await refusal(createQuote(fake, context, { branchId: context.branchId,
    lines: [{ needId: NEED, needVersion: 1, quantity: '3', unit: 'box' }], constraints: { supplierIds: [], paymentTerm: 'cash' } }));
  assert.equal(error.status, 422); assert.equal(error.code, 'QUANTITY_EXCEEDS_NEED');
  assert.deepEqual(mutations(fake.calls), []);
});

test('GUARD 1: a stored idempotent replay performs no mutation at all', async () => {
  const hash = createHash('sha256').update(JSON.stringify({ quoteId: QUOTE, quoteVersion: 1 })).digest('hex');
  const stored = client({ replay: { request_hash: hash, status: 202, body: { approvalId: 'stored' } } });
  const result = await approveQuote(stored, context, QUOTE, 1, 'harness-key');
  assert.deepEqual(result, { status: 202, body: { approvalId: 'stored' } });
  assert.deepEqual(mutations(stored.calls), []);
});

test('GUARD 2: a second key for an already approved quote never settles the need again', async () => {
  const fake = client({ quoteStatus: 'approved' });
  const result = await approveQuote(fake, context, QUOTE, 1, 'another-key');
  assert.equal(result.status, 200);
  assert.deepEqual(fake.calls.filter(call => call.text.includes('UPDATE need SET')), []);
});
```

## 5. Limitations and follow-up for the coordinator

- No database test was executed here. The 343-test baseline is not re-verified; only the 324 non-database
  tests were rerun. `packages/db/test/{api,quotes,supplier,inventory,runtime}.test.ts` and
  `database.test.mjs` must be rerun because `procurement.ts` changed.
- `quotes.test.ts` was read and is expected to remain valid: its approval covers the need in full
  (`quantity '2'` of `requested_quantity 2`), so the need still becomes `covered` at version 2 and its
  later `UPDATE need SET status='open',version=2` still leaves `requested_quantity` at `2`. That is an
  expectation, not a measured result.
- `0012_procurement_invariants.sql` contains only `COMMENT ON` statements. Nothing in the code depends
  on it, so it can be deferred or dropped without affecting behaviour.
- Two new refusal codes cross the API boundary: `422 QUANTITY_EXCEEDS_NEED` and
  `409 IDEMPOTENCY_KEY_SCOPE_CONFLICT`. Error codes are free-form strings in `apps/api/src/errors.ts`
  and are not enumerated in the generated contracts, so no contract regeneration was required, but the
  OpenAPI error vocabulary should adopt them before publication.
- Creating a quote still does not reserve the need. Two quotes may each be created for the whole
  remainder; the loser is refused at approval by the need version check and must requote. If the
  product should instead hold the quantity at quote time, that is a policy decision for the
  coordinator, not a defect of this fix.
- Acceptance-plan open decision 10 (proportional reservation release on partial supplier rejection)
  is untouched. This change concerns partial *quoting* of a need, not partial supplier acceptance.
- `docs/STATUS.md` was not edited; it is not owned by this task. Its note that "partial-need
  fulfilment and cross-branch idempotency key collision handling require further review" can be
  updated once the integration run passes.
