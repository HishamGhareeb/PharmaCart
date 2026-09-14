import { randomUUID } from 'node:crypto';

import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';
import type { RuntimeClient, TenantContext } from './runtime.ts';

/**
 * Explicit human pack mapping. A person selects one shared catalogue pack identity for one need;
 * nothing here infers a mapping from text, folds identifiers, or converts between pack units.
 */
export class MappingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = 'MappingError';
  }
}

/** Upper bound on catalogue rows one candidate response may disclose. */
export const MAX_MAPPING_CANDIDATES = 20;

export type PackSize = Readonly<{ value: string; unit: string }>;

/** The complete catalogue identity a pack must carry before a human may select it. */
export type CatalogueIdentity = Readonly<{
  brand: string;
  manufacturer: string;
  strength: string;
  dosageForm: string;
  packSize: PackSize;
  saleUnit: string;
}>;

export type MappingCandidate = Readonly<{ productId: string; identity: CatalogueIdentity }>;
export type CatalogueRow = Readonly<{ id: string; status: string; identity: unknown }>;

export type MappingUnitBasis = 'authoritative_metadata' | 'explicit_supplied_unit';
export type ResolvedMappingUnit = Readonly<{ unit: string; basis: MappingUnitBasis }>;

export type MappingNeedView = Readonly<{
  id: string;
  version: number;
  status: string;
  productRef: string;
  currentProductId: string | null;
}>;

export type MappingCandidatesView = Readonly<{
  needId: string;
  needVersion: number;
  needStatus: string;
  productRef: string;
  currentProductId: string | null;
  authoritativeUnit: string | null;
  unitBasis: 'authoritative_metadata' | 'explicit_supplied_unit_required';
  /** Always true: an eligible single candidate is still a human decision, never an automatic one. */
  selectionRequired: true;
  ambiguous: boolean;
  /** True when the catalogue window hit MAX_MAPPING_CANDIDATES, so the list is not exhaustive. */
  truncated: boolean;
  /** Rows in the fetched window rejected for an incomplete or unverified identity. */
  unselectableExcluded: number;
  candidates: readonly MappingCandidate[];
}>;

export type BindMappingCommand = Readonly<{
  needVersion: number;
  productId: string;
  suppliedUnit?: string;
}>;

export type MappingRecord = Readonly<{
  needId: string;
  needVersion: number;
  mapId: string;
  productId: string;
  mapStatus: 'verified';
  unit: string;
  unitBasis: MappingUnitBasis;
  decisionId: string | null;
  repeated: boolean;
}>;

export type BindMappingResult = Readonly<{ created: boolean; mapping: MappingRecord }>;

type NeedRow = {
  id: string;
  productRef: string;
  status: string;
  version: number;
  sourceRef: string | null;
  sourceMapId: string | null;
};

type ExistingDecision = Readonly<{
  mapId: string;
  decisionId: string;
  unit: string;
  unitBasis: MappingUnitBasis;
}>;

const NEED_COLUMNS =
  'id, product_ref AS "productRef", status, version, source_ref AS "sourceRef", source_map_id AS "sourceMapId"';

/** Accepts only a non-empty string that carries no surrounding whitespace to fold away. */
function exactText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads a stored catalogue identity, returning null unless every commercial field is present and
 * canonical. An incomplete identity is never partially trusted.
 */
export function readCatalogueIdentity(value: unknown): CatalogueIdentity | null {
  const source = plainObject(value);
  if (source === null) return null;
  const packSize = plainObject(source.packSize);
  if (packSize === null) return null;
  const brand = exactText(source.brand);
  const manufacturer = exactText(source.manufacturer);
  const strength = exactText(source.strength);
  const dosageForm = exactText(source.dosageForm);
  const saleUnit = exactText(source.saleUnit);
  const packValue = exactText(packSize.value);
  const packUnit = exactText(packSize.unit);
  if (brand === null || manufacturer === null || strength === null || dosageForm === null
    || saleUnit === null || packValue === null || packUnit === null) return null;
  if (!isPositiveDecimalString(packValue, { maxLength: 32 })) return null;
  return { brand, manufacturer, strength, dosageForm, packSize: { value: packValue, unit: packUnit }, saleUnit };
}

/**
 * Decides which unit a mapping is recorded against. Units are compared by exact equality: a strip
 * never satisfies a box, and a need without authoritative unit metadata requires the request to
 * state the unit explicitly, so the decision is provenanced rather than asserted as an automatic
 * match. The supplied unit records what the request claimed, not an observation the module verified.
 */
export function resolveMappingUnit(input: Readonly<{
  authoritativeUnit: string | null;
  suppliedUnit: string | undefined;
  saleUnit: string;
}>): ResolvedMappingUnit {
  if (input.authoritativeUnit !== null) {
    if (input.authoritativeUnit !== input.saleUnit) throw new MappingError(422, 'UNIT_MISMATCH');
    if (input.suppliedUnit !== undefined && input.suppliedUnit !== input.authoritativeUnit) {
      throw new MappingError(422, 'UNIT_MISMATCH');
    }
    return { unit: input.authoritativeUnit, basis: 'authoritative_metadata' };
  }
  if (input.suppliedUnit === undefined) throw new MappingError(422, 'SUPPLIED_UNIT_REQUIRED');
  if (input.suppliedUnit !== input.saleUnit) throw new MappingError(422, 'UNIT_MISMATCH');
  return { unit: input.suppliedUnit, basis: 'explicit_supplied_unit' };
}

/** Keeps verified, complete and unit-consistent catalogue rows, ordered by stable pack identity. */
export function selectEligibleCandidates(
  rows: readonly CatalogueRow[],
  authoritativeUnit: string | null,
): MappingCandidate[] {
  const eligible: MappingCandidate[] = [];
  for (const row of rows) {
    if (row.status !== 'verified') continue;
    const identity = readCatalogueIdentity(row.identity);
    if (identity === null) continue;
    if (authoritativeUnit !== null && identity.saleUnit !== authoritativeUnit) continue;
    eligible.push({ productId: row.id, identity });
  }
  return eligible.sort((left, right) => left.productId.localeCompare(right.productId));
}

/**
 * Assembles the candidate response. It carries pack identity only: account offers, prices and
 * suppliers are deliberately absent, and no candidate is ever marked as chosen.
 */
export function buildCandidatesView(input: Readonly<{
  need: MappingNeedView;
  authoritativeUnit: string | null;
  rows: readonly CatalogueRow[];
}>): MappingCandidatesView {
  const eligible = selectEligibleCandidates(input.rows, input.authoritativeUnit);
  return {
    needId: input.need.id,
    needVersion: input.need.version,
    needStatus: input.need.status,
    productRef: input.need.productRef,
    currentProductId: input.need.currentProductId,
    authoritativeUnit: input.authoritativeUnit,
    unitBasis: input.authoritativeUnit === null ? 'explicit_supplied_unit_required' : 'authoritative_metadata',
    selectionRequired: true,
    ambiguous: eligible.length > 1,
    truncated: input.rows.length > MAX_MAPPING_CANDIDATES,
    unselectableExcluded: input.rows.length - eligible.length,
    candidates: eligible.slice(0, MAX_MAPPING_CANDIDATES),
  };
}

export function assertMappingReadAllowed(context: TenantContext): void {
  if (context.organisationKind !== 'pharmacy' || !['pharmacy_owner', 'purchaser'].includes(context.role)) {
    throw new MappingError(403, 'FORBIDDEN');
  }
}

export function assertMappingWriteAllowed(context: TenantContext): void {
  if (context.organisationKind !== 'pharmacy' || context.role !== 'pharmacy_owner') {
    throw new MappingError(403, 'FORBIDDEN');
  }
}

/** Row level security hides other tenants' needs, so an invisible need is reported as absent. */
async function loadNeed(client: RuntimeClient, needId: string, lock: boolean): Promise<NeedRow> {
  const result = await client.query<NeedRow>(
    `SELECT ${NEED_COLUMNS} FROM need WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [needId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new MappingError(404, 'NOT_FOUND');
  return row;
}

/**
 * Authoritative unit metadata comes from the connector target that produced the need. Nothing is
 * inferred when the need has no source reference or no matching target, and conflicting targets
 * refuse rather than picking one.
 */
async function loadAuthoritativeUnit(
  client: RuntimeClient,
  context: TenantContext,
  need: NeedRow,
): Promise<string | null> {
  if (need.sourceRef === null) return null;
  const result = await client.query<{ unit: string }>(
    `SELECT DISTINCT target.unit FROM inventory_target target
      WHERE target.organisation_id=$2 AND target.branch_id=$3 AND target.product_ref=$4
        AND target.installation_id::text || ':' || target.source_code = $1`,
    [need.sourceRef, context.organisationId, context.branchId, need.productRef],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new MappingError(409, 'AMBIGUOUS_NEED_UNIT');
  return result.rows[0]!.unit;
}

async function loadCurrentProductId(client: RuntimeClient, need: NeedRow): Promise<string | null> {
  if (need.sourceMapId === null) return null;
  const result = await client.query<{ product_id: string | null }>(
    'SELECT product_id FROM source_product_map WHERE id=$1',
    [need.sourceMapId],
  );
  return result.rows[0]?.product_id ?? null;
}

/** Bounded read of the shared catalogue: one row beyond the limit only to report truncation. */
async function fetchCatalogueWindow(
  client: RuntimeClient,
  authoritativeUnit: string | null,
): Promise<CatalogueRow[]> {
  const result = await client.query<CatalogueRow>(
    `SELECT id, status, identity FROM procurement_product
      WHERE status='verified' AND ($1::text IS NULL OR identity->>'saleUnit'=$1)
      ORDER BY id LIMIT $2`,
    [authoritativeUnit, MAX_MAPPING_CANDIDATES + 1],
  );
  return result.rows;
}

/**
 * Finds the provenanced decision behind the need's current mapping. A map recorded without a
 * decision cannot prove a human chose it, so it is never treated as an idempotent repeat.
 */
async function loadExistingDecision(
  client: RuntimeClient,
  need: NeedRow,
  productId: string,
): Promise<ExistingDecision | null> {
  if (need.sourceMapId === null) return null;
  const result = await client.query<{
    map_id: string;
    decision_id: string;
    unit: string;
    unit_basis: MappingUnitBasis;
  }>(
    `SELECT decision.map_id, decision.id AS decision_id, decision.unit, decision.unit_basis
       FROM need_mapping_decision decision
       JOIN source_product_map map ON map.id=decision.map_id
      WHERE decision.need_id=$1 AND decision.map_id=$2 AND decision.product_id=$3
        AND map.product_id=$3 AND map.status='verified'`,
    [need.id, need.sourceMapId, productId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { mapId: row.map_id, decisionId: row.decision_id, unit: row.unit, unitBasis: row.unit_basis };
}

/**
 * Lists the shared verified catalogue pack identities a human may choose for one need. Purchasers
 * and owners may read; the result is bounded, carries no account pricing, and marks nothing chosen.
 */
export async function listMappingCandidates(
  client: RuntimeClient,
  context: TenantContext,
  needId: string,
): Promise<MappingCandidatesView> {
  assertMappingReadAllowed(context);
  const need = await loadNeed(client, needId, false);
  const authoritativeUnit = await loadAuthoritativeUnit(client, context, need);
  const currentProductId = await loadCurrentProductId(client, need);
  const rows = await fetchCatalogueWindow(client, authoritativeUnit);
  return buildCandidatesView({
    need: {
      id: need.id,
      version: need.version,
      status: need.status,
      productRef: need.productRef,
      currentProductId,
    },
    authoritativeUnit,
    rows,
  });
}

/**
 * Binds one explicitly selected catalogue pack to one need at an expected need version.
 *
 * The need row is locked for the whole transaction, so the version and status read here are the ones
 * settled below. Recording a new mapping increments the need version, which invalidates every quote
 * that captured the earlier version without touching any stored quote snapshot. The shared catalogue
 * is only read: the runtime role holds no write privilege on procurement_product.
 */
export async function bindNeedMapping(
  client: RuntimeClient,
  context: TenantContext,
  needId: string,
  command: BindMappingCommand,
): Promise<BindMappingResult> {
  assertMappingWriteAllowed(context);
  const need = await loadNeed(client, needId, true);
  if (need.version !== command.needVersion) throw new MappingError(409, 'NEED_VERSION_CONFLICT');
  // A covered or closed need is settled history: its mapping is no longer editable.
  if (need.status !== 'open') throw new MappingError(409, 'NEED_NOT_OPEN');

  const product = (await client.query<{ id: string; status: string; identity: unknown }>(
    'SELECT id, status, identity FROM procurement_product WHERE id=$1 FOR SHARE',
    [command.productId],
  )).rows[0];
  if (product === undefined || product.status !== 'verified') throw new MappingError(422, 'CATALOGUE_UNVERIFIED');
  const identity = readCatalogueIdentity(product.identity);
  if (identity === null) throw new MappingError(422, 'CATALOGUE_IDENTITY_INCOMPLETE');

  const authoritativeUnit = await loadAuthoritativeUnit(client, context, need);
  const resolved = resolveMappingUnit({
    authoritativeUnit,
    suppliedUnit: command.suppliedUnit,
    saleUnit: identity.saleUnit,
  });

  // Repeating the same selection at the need's current state changes nothing, so the version and
  // every quote that depends on it stay valid.
  const existing = await loadExistingDecision(client, need, command.productId);
  if (existing !== null && existing.unit === resolved.unit && existing.unitBasis === resolved.basis) {
    return {
      created: false,
      mapping: {
        needId: need.id,
        needVersion: need.version,
        mapId: existing.mapId,
        productId: command.productId,
        mapStatus: 'verified',
        unit: resolved.unit,
        unitBasis: resolved.basis,
        decisionId: existing.decisionId,
        repeated: true,
      },
    };
  }

  // Provenance records how many packs were eligible for this need at bind time, so an ambiguous
  // catalogue cannot later be read as an automatic single match. It is a server-side count of
  // eligibility, not a record that any candidate list was rendered to or read by a person.
  const view = buildCandidatesView({
    need: { id: need.id, version: need.version, status: need.status, productRef: need.productRef, currentProductId: null },
    authoritativeUnit,
    rows: await fetchCatalogueWindow(client, authoritativeUnit),
  });
  const observedCandidateCount = view.candidates.some((candidate) => candidate.productId === command.productId)
    ? view.candidates.length
    : view.candidates.length + 1;

  const previousVersion = need.sourceMapId === null
    ? 0
    : (await client.query<{ version: number }>('SELECT version FROM source_product_map WHERE id=$1', [need.sourceMapId]))
      .rows[0]?.version ?? 0;
  const mapId = randomUUID();
  await client.query(
    `INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version)
     VALUES($1,$2,$3,$4,'verified',$5)`,
    [mapId, context.organisationId, context.branchId, command.productId, previousVersion + 1],
  );
  const settled = await client.query(
    "UPDATE need SET source_map_id=$2, version=version+1 WHERE id=$1 AND version=$3 AND status='open'",
    [need.id, mapId, need.version],
  );
  if (settled.rowCount !== 1) throw new MappingError(409, 'NEED_VERSION_CONFLICT');

  const decisionId = randomUUID();
  // The decision key (organisation, need, observed version) refuses a second decision recorded
  // against the same observed version even if the need lock were ever released early.
  const recorded = await client.query(
    `INSERT INTO need_mapping_decision(id,organisation_id,branch_id,need_id,need_version,map_id,product_id,
       decided_by,decision,unit_basis,unit,supplied_unit,authoritative_unit,
       observed_candidate_count,observed_candidates_truncated)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'explicit_human_selection',$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING`,
    [decisionId, context.organisationId, context.branchId, need.id, need.version, mapId, command.productId,
      context.membershipId, resolved.basis, resolved.unit, command.suppliedUnit ?? null, authoritativeUnit,
      observedCandidateCount, view.truncated],
  );
  if (recorded.rowCount !== 1) throw new MappingError(409, 'MAPPING_DECISION_CONFLICT');

  return {
    created: true,
    mapping: {
      needId: need.id,
      needVersion: need.version + 1,
      mapId,
      productId: command.productId,
      mapStatus: 'verified',
      unit: resolved.unit,
      unitBasis: resolved.basis,
      decisionId,
      repeated: false,
    },
  };
}

