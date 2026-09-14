import { createHash } from 'node:crypto';

import type { RuntimeClient } from './runtime.ts';

/**
 * Tenant-scoped list reads for the authenticated web flow.
 *
 * Enforcement model, deliberately narrow:
 * - Row level security is the *only* tenant predicate. The statements below carry no
 *   `organisation_id`/`branch_id` filter of their own, so they return nothing at all unless the
 *   caller already established `app.organisation_id` and `app.branch_id` through `withTransaction`.
 *   `packages/db/test/lists.test.ts` asserts the no-context case returns zero rows.
 * - Every caller-supplied value is bound as a parameter. The only caller value that reaches the
 *   query *shape* is an allowlisted status token compared with `=`, never interpolated.
 * - No total, no count and no existence signal crosses a tenant boundary: a page reports its own
 *   rows and an opaque continuation token, nothing else.
 */

export class ListError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ListError';
    this.status = status;
    this.code = code;
  }
}

/** Messages are fixed sentences: no caller input is ever echoed back. */
const invalidRequest = () => new ListError(400, 'INVALID_REQUEST', 'The list query does not match the required contract.');
const invalidCursor = () => new ListError(400, 'INVALID_CURSOR', 'The pagination cursor is not valid for this request.');
const internal = () => new ListError(500, 'INTERNAL_ERROR', 'The list could not be built.');
/** Word for word the refusal a denied membership produces, so the two cannot be told apart. */
const forbidden = () => new ListError(403, 'FORBIDDEN', 'The selected scope is not permitted.');

export type ListKind = 'needs' | 'orders';

/**
 * The part of a `TenantContext` a *cursor* is bound to. Deliberately just the two tenant selectors:
 * nothing else belongs in a fingerprint. `TenantContext` satisfies it structurally.
 */
export type ListScopeKey = Readonly<{ organisationId: string; branchId: string }>;

/**
 * The part of a `TenantContext` a list *read* depends on. `TenantContext` satisfies it structurally.
 * Wider than `ListScopeKey` because a read must also know whose side of the market it is serving.
 */
export type ListPrincipal = ListScopeKey & Readonly<{ organisationKind: string }>;

/**
 * Needs and order intents are pharmacy-side procurement records. Every other procurement entry point
 * refuses a non-pharmacy principal in this layer rather than relying on row level security happening
 * to match nothing - see the same check opening `createQuote` and `confirmReceipt`. A list is held to
 * the same rule, and the refusal is the membership refusal verbatim so it discloses no more than one.
 *
 * Which *role* inside a pharmacy may list is a separate, undecided question: the write paths disagree
 * with one another and no read policy exists. It stays with the coordinator; see
 * docs/testing/tenant-list-api.md section 6.
 */
export function requirePharmacyPrincipal(principal: ListPrincipal): void {
  if (principal.organisationKind !== 'pharmacy') throw forbidden();
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_STATUS_LENGTH = 32;
export const MAX_SALE_UNIT_LENGTH = 64;

/**
 * Server-side ceiling on a single list statement. Read-only list pages take no row locks and never
 * retry, so this is the only wait the endpoint can incur; bounding it in PostgreSQL rather than with
 * a client-side deadline avoids depending on any wall-clock or monotonic reading in the API process.
 */
export const LIST_STATEMENT_TIMEOUT_MS = 5000;

const QUERY_KEYS = ['limit', 'status', 'cursor'] as const;

const STATUS_ALLOWLIST: Readonly<Record<ListKind, readonly string[]>> = {
  // 0001_identity_and_tenant_isolation.sql: need.status CHECK
  needs: ['open', 'quoted', 'covered', 'closed'],
  // 0007_transactional_procurement.sql: order_intent.state CHECK
  orders: ['queued', 'submitting', 'outcome_unknown', 'acknowledged', 'rejected', 'human_review'],
};

/** An intent in one of these states may have reached the supplier; retrying it is not safe. */
const UNCERTAIN_STATES: readonly string[] = ['submitting', 'outcome_unknown', 'human_review'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type ParsedListQuery = Readonly<{ limit: number; status: string | null; cursor: string | null }>;
export type ListQuery = Readonly<{ limit: number; status: string | null; after: string | null }>;
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

/**
 * Validates the raw query string of a list request. Purely syntactic: it never touches the database
 * and never needs an authenticated scope, so a malformed request is refused before a connection is
 * taken and before a membership lookup runs.
 */
export function parseListQuery(kind: ListKind, raw: unknown): ParsedListQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidRequest();
  const query = raw as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) throw invalidRequest();
  }
  return { limit: parseLimit(query.limit), status: parseStatus(kind, query.status), cursor: parseCursor(query.cursor) };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !LIMIT.test(value)) throw invalidRequest();
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalidRequest();
  return limit;
}

function parseStatus(kind: ListKind, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_STATUS_LENGTH) throw invalidRequest();
  // Allowlist membership is the whole filter vocabulary. Anything else - an identifier, an operator,
  // a quote, a comment marker - is refused here and never reaches a statement.
  if (!STATUS_ALLOWLIST[kind].includes(value)) throw invalidRequest();
  return value;
}

function parseCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw invalidRequest();
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL.test(value)) throw invalidCursor();
  return value;
}

// ---------------------------------------------------------------------------
// Opaque keyset cursor
// ---------------------------------------------------------------------------

const CURSOR_VERSION = 1;

/**
 * Binds a cursor to the scope, resource and filter that issued it. It is a plain digest, not a
 * signature: the cursor is opaque by contract, not confidential. Its only job is to make a cursor
 * from one scope, resource or filter unusable in another, so pagination cannot be steered. Actual
 * visibility stays with row level security, which would refuse a forged token's rows anyway.
 */
export function scopeFingerprint(kind: ListKind, scope: ListScopeKey, status: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([CURSOR_VERSION, kind, scope.organisationId, scope.branchId, status]))
    .digest('base64url')
    .slice(0, 22);
}

export function encodeCursor(kind: ListKind, scope: ListScopeKey, status: string | null, id: string): string {
  if (!UUID.test(id)) throw internal();
  const payload = { v: CURSOR_VERSION, s: scopeFingerprint(kind, scope, status), a: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, refusing anything that is not the exact shape this module issued for this exact
 * scope, resource and filter. Every refusal is the same 400, so a foreign cursor is indistinguishable
 * from a malformed one and cannot be used to probe another tenant.
 */
export function decodeCursor(cursor: string, kind: ListKind, scope: ListScopeKey, status: string | null): string {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) throw invalidCursor();
  const decoded = Buffer.from(cursor, 'base64url');
  // Buffer's base64 decoder is lenient; requiring an exact re-encode keeps one cursor per position.
  if (decoded.toString('base64url') !== cursor) throw invalidCursor();

  let payload: unknown;
  try { payload = JSON.parse(decoded.toString('utf8')); } catch { throw invalidCursor(); }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw invalidCursor();

  const keys = Object.keys(payload).sort();
  if (keys.length !== 3 || keys[0] !== 'a' || keys[1] !== 's' || keys[2] !== 'v') throw invalidCursor();
  const { v, s, a } = payload as Record<'v' | 's' | 'a', unknown>;
  if (v !== CURSOR_VERSION) throw invalidCursor();
  if (typeof s !== 'string' || s !== scopeFingerprint(kind, scope, status)) throw invalidCursor();
  if (typeof a !== 'string' || !UUID.test(a)) throw invalidCursor();
  return a;
}

/** Resolves a parsed query against the *authenticated* scope, never against a request header. */
export function bindListQuery(parsed: ParsedListQuery, kind: ListKind, scope: ListScopeKey): ListQuery {
  return {
    limit: parsed.limit,
    status: parsed.status,
    after: parsed.cursor === null ? null : decodeCursor(parsed.cursor, kind, scope, parsed.status),
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export type NeedMappingStatus = 'unmapped' | 'unverified' | 'verified';

export type NeedRow = Readonly<{
  id: string;
  productRef: string;
  quantity: string;
  status: string;
  version: number;
  sourceMapId: string | null;
  mapStatus: string | null;
  productStatus: string | null;
  productId: string | null;
  saleUnit: unknown;
}>;

export type NeedSummary = Readonly<{
  id: string;
  productRef: string;
  quantity: string;
  /** Null when the row's status has no recorded outstanding-demand reading. See `outstanding`. */
  outstandingQuantity: string | null;
  status: string;
  version: number;
  mappingStatus: NeedMappingStatus;
  productId: string | null;
  saleUnit: string | null;
}>;

export type OrderUncertainty = Readonly<{ safeToRetry: false; nextAction: 'reconciliation_required' }>;

export type OrderRow = Readonly<{
  id: string;
  state: string;
  version: number;
  externalClientRef: string;
  externalOrderId: string | null;
  lineCount: number;
  settledLines: number;
  awaitingReceiptLines: number;
}>;

export type OrderSummary = Readonly<{
  id: string;
  state: string;
  version: number;
  externalClientRef: string;
  externalOrderId: string | null;
  lines: Readonly<{ total: number; settled: number; awaitingReceipt: number }>;
  uncertainty: OrderUncertainty | null;
}>;

/**
 * The authoritative sale unit of a mapped product, or null when it is unknown. A unit is only ever
 * reported when the catalogue holds it as a plain string; nothing is derived, converted or invented.
 */
export function safeSaleUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_SALE_UNIT_LENGTH || value.trim() !== value) return null;
  return value;
}

/**
 * Outstanding demand, only where the schema records what it means.
 * `0012_procurement_invariants.sql` defines the reading for exactly three statuses: while a need is
 * `open` the column *is* the outstanding demand; once it is `covered` or `closed` the outstanding
 * demand is zero and the column is frozen at the final tranche. `quoted` is permitted by the CHECK in
 * `0001_identity_and_tenant_isolation.sql` and written by no code path today, so it has no recorded
 * reading - answering `'0'` there would assert there is nothing left to procure, which is exactly the
 * kind of invention the sale unit rule refuses. Unknown is reported as unknown.
 */
function outstanding(status: string, quantity: string): string | null {
  if (status === 'open') return quantity;
  return status === 'covered' || status === 'closed' ? '0' : null;
}

export function toNeedSummary(row: NeedRow): NeedSummary {
  // A product identity is disclosed only through a mapping the tenant has verified, to a catalogue
  // entry that is itself verified. The statement gates these columns too; this is the second gate.
  const verified = row.mapStatus === 'verified' && row.productStatus === 'verified';
  return {
    id: row.id,
    productRef: row.productRef,
    quantity: row.quantity,
    outstandingQuantity: outstanding(row.status, row.quantity),
    status: row.status,
    version: row.version,
    mappingStatus: row.sourceMapId === null ? 'unmapped' : verified ? 'verified' : 'unverified',
    productId: verified ? row.productId : null,
    saleUnit: verified ? safeSaleUnit(row.saleUnit) : null,
  };
}

/** Mirrors the individual order route so the list grants no different a reading of an intent. */
export function orderUncertainty(state: string): OrderUncertainty | null {
  return UNCERTAIN_STATES.includes(state) ? { safeToRetry: false, nextAction: 'reconciliation_required' } : null;
}

function requireCount(value: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw internal();
  return value;
}

export function toOrderSummary(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    externalClientRef: row.externalClientRef,
    externalOrderId: row.externalOrderId,
    // Line counts, not summed quantities: lines of one intent may carry different sale units, so a
    // single total would be a fabricated figure. Per-line quantities stay on /v1/orders/:id.
    lines: {
      total: requireCount(row.lineCount),
      settled: requireCount(row.settledLines),
      awaitingReceipt: requireCount(row.awaitingReceiptLines),
    },
    uncertainty: orderUncertainty(row.state),
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const NEEDS_SQL = `SELECT n.id,
       n.product_ref AS "productRef",
       n.requested_quantity::text AS quantity,
       n.status,
       n.version,
       n.source_map_id AS "sourceMapId",
       m.status AS "mapStatus",
       p.status AS "productStatus",
       CASE WHEN m.status='verified' AND p.status='verified' THEN p.id END AS "productId",
       CASE WHEN m.status='verified' AND p.status='verified' AND jsonb_typeof(p.identity->'saleUnit')='string'
            THEN p.identity->>'saleUnit' END AS "saleUnit"
  FROM need AS n
  LEFT JOIN source_product_map AS m ON m.id=n.source_map_id
  LEFT JOIN procurement_product AS p ON p.id=m.product_id
 WHERE ($1::text IS NULL OR n.status=$1::text)
   AND ($2::uuid IS NULL OR n.id>$2::uuid)
 ORDER BY n.id
 LIMIT $3::int`;

const ORDERS_SQL = `SELECT i.id,
       i.state,
       i.version,
       i.external_client_ref AS "externalClientRef",
       i.external_order_id AS "externalOrderId",
       count(l.id)::int AS "lineCount",
       count(l.id) FILTER (WHERE l.accepted+l.rejected=l.ordered AND l.received=l.accepted)::int AS "settledLines",
       count(l.id) FILTER (WHERE l.received<l.shipped)::int AS "awaitingReceiptLines"
  FROM order_intent AS i
  LEFT JOIN order_line AS l ON l.intent_id=i.id
 WHERE ($1::text IS NULL OR i.state=$1::text)
   AND ($2::uuid IS NULL OR i.id>$2::uuid)
 GROUP BY i.id, i.state, i.version, i.external_client_ref, i.external_order_id
 ORDER BY i.id
 LIMIT $3::int`;

/**
 * Caps the statement inside the caller's transaction. `set_config(..., true)` is transaction-local
 * and reverts on commit or rollback, so it cannot leak into another request on a pooled connection.
 * It is a no-op outside a transaction; every production caller runs under `withTransaction`.
 */
async function boundStatementTime(client: RuntimeClient): Promise<void> {
  await client.query(`SELECT set_config('statement_timeout',$1,true)`, [String(LIST_STATEMENT_TIMEOUT_MS)]);
}

function page<T extends { id: string }>(kind: ListKind, scope: ListScopeKey, query: ListQuery, rows: readonly T[]): Page<T> {
  // One extra row is read to learn whether a further page exists without counting anything.
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(kind, scope, query.status, last.id) : null,
  };
}

export async function listNeeds(client: RuntimeClient, principal: ListPrincipal, query: ListQuery): Promise<Page<NeedSummary>> {
  requirePharmacyPrincipal(principal);
  requireBoundedQuery(query);
  await boundStatementTime(client);
  const result = await client.query(NEEDS_SQL, [query.status, query.after, query.limit + 1]);
  return page('needs', principal, query, (result.rows as NeedRow[]).map(toNeedSummary));
}

export async function listOrders(client: RuntimeClient, principal: ListPrincipal, query: ListQuery): Promise<Page<OrderSummary>> {
  requirePharmacyPrincipal(principal);
  requireBoundedQuery(query);
  await boundStatementTime(client);
  const result = await client.query(ORDERS_SQL, [query.status, query.after, query.limit + 1]);
  return page('orders', principal, query, (result.rows as OrderRow[]).map(toOrderSummary));
}

/** Last-resort guard: a repository call must never run with an unvalidated bound. */
function requireBoundedQuery(query: ListQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) throw internal();
  if (query.after !== null && !UUID.test(query.after)) throw internal();
}
