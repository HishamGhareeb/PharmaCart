import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildApp } from '../src/app.ts';
import { registerMappingRoutes } from '../src/mapping-routes.ts';
import type { TenantScope, TokenVerifier } from '../src/request-auth.ts';
import type { CatalogueRow } from '../../../packages/db/src/mapping.ts';
import type { MembershipRole, OrganisationKind, RuntimeClient, TenantContext } from '../../../packages/db/src/runtime.ts';

/*
 * Route-boundary fixture for the explicit mapping routes. It executes no SQL: a scripted client answers
 * the statements packages/db/src/mapping.ts issues, so the real repository functions, the real route
 * and the real error handler produce every response. Whether those statements are valid PostgreSQL is
 * decided only by packages/db/test/mapping.test.ts and packages/db/test/openapi-registered-live.test.ts.
 */

export const MAPPING_IDS = {
  organisation: '10000000-0000-4000-8000-000000000001',
  foreignOrganisation: '10000000-0000-4000-8000-000000000002',
  branch: '20000000-0000-4000-8000-000000000001',
  foreignBranch: '20000000-0000-4000-8000-000000000002',
  membership: '30000000-0000-4000-8000-000000000001',
  need: '40000000-0000-4000-8000-000000000003',
  foreignNeed: '40000000-0000-4000-8000-000000000002',
  installation: '50000000-0000-4000-8000-000000000009',
  product: '60000000-0000-4000-8000-000000000001',
  otherProduct: '60000000-0000-4000-8000-000000000002',
  map: '70000000-0000-4000-8000-000000000001',
  decision: 'aa0b6d1c-9f42-4f6e-9c4d-2f1a7b3c5d05',
} as const;

export const MAPPING_HEADERS = {
  authorization: 'Bearer synthetic',
  'x-organisation-id': MAPPING_IDS.organisation,
  'x-branch-id': MAPPING_IDS.branch,
} as const;

export function mappingContext(role: MembershipRole = 'pharmacy_owner', organisationKind: OrganisationKind = 'pharmacy'): TenantContext {
  return {
    principalKind: 'member',
    userSubject: 'synthetic:user:a',
    membershipId: MAPPING_IDS.membership,
    organisationId: MAPPING_IDS.organisation,
    organisationKind,
    branchId: MAPPING_IDS.branch,
    allowedBranchIds: [MAPPING_IDS.branch],
    role,
    membershipVersion: 1,
  };
}

export function packIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brand: 'SYN Brand',
    manufacturer: 'SYN Maker',
    strength: '5 mg',
    dosageForm: 'tablet',
    packSize: { value: '20', unit: 'tablet' },
    saleUnit: 'box',
    ...overrides,
  };
}

export type ScriptedNeed = Readonly<{
  id: string;
  productRef: string;
  status: string;
  version: number;
  sourceRef: string | null;
  sourceMapId: string | null;
}>;

export type ScriptedDecision = Readonly<{ map_id: string; decision_id: string; unit: string; unit_basis: string }>;

/** What the database would hold for the acting tenant. A need invisible under row level security is `null`. */
export type MappingWorld = Readonly<{
  need: ScriptedNeed | null;
  authoritativeUnits?: readonly string[];
  currentProductId?: string | null;
  catalogue?: readonly CatalogueRow[];
  product?: CatalogueRow | null;
  existingDecision?: ScriptedDecision | null;
  previousMapVersion?: number;
  needUpdateRowCount?: number;
  decisionInsertRowCount?: number;
  failure?: Error;
}>;

export const OPEN_NEED: ScriptedNeed = {
  id: MAPPING_IDS.need,
  productRef: 'SYN-C',
  status: 'open',
  version: 1,
  sourceRef: null,
  sourceMapId: null,
};

export const VERIFIED_CATALOGUE: readonly CatalogueRow[] = [
  { id: MAPPING_IDS.product, status: 'verified', identity: packIdentity() },
  { id: MAPPING_IDS.otherProduct, status: 'verified', identity: packIdentity({ strength: '10 mg' }) },
  // Verified but incomplete: withheld from the candidates and counted as unselectable.
  { id: '60000000-0000-4000-8000-000000000003', status: 'verified', identity: packIdentity({ manufacturer: undefined }) },
];

export const MAPPING_BIND_URL = `/v1/needs/${MAPPING_IDS.need}/mapping`;
export const MAPPING_CANDIDATES_URL = `/v1/needs/${MAPPING_IDS.need}/mapping-candidates`;
export const SELECTION = { needVersion: 1, productId: MAPPING_IDS.product, suppliedUnit: 'box' } as const;

export type MappingRefusal = Readonly<{
  name: string;
  world: MappingWorld;
  tenant?: TenantContext;
  write: boolean;
  payload?: Record<string, unknown>;
  status: number;
  code: string;
  message: string;
}>;

const NOT_PERMITTED = 'The selected scope is not permitted.';
const NOT_COMPLETED = 'The mapping request could not be completed.';
const NOT_FOUND = 'The requested resource was not found.';

/** Every refusal the two mapping routes can produce from the repository, one row per code. */
export const MAPPING_REFUSALS: readonly MappingRefusal[] = [
  { name: 'receiver reading candidates', world: { need: OPEN_NEED }, tenant: mappingContext('receiver'), write: false, status: 403, code: 'FORBIDDEN', message: NOT_PERMITTED },
  { name: 'purchaser binding', world: { need: OPEN_NEED }, tenant: mappingContext('purchaser'), write: true, status: 403, code: 'FORBIDDEN', message: NOT_PERMITTED },
  { name: 'supplier owner binding', world: { need: OPEN_NEED }, tenant: mappingContext('pharmacy_owner', 'supplier'), write: true, status: 403, code: 'FORBIDDEN', message: NOT_PERMITTED },
  { name: 'invisible need candidates', world: { need: null }, write: false, status: 404, code: 'NOT_FOUND', message: NOT_FOUND },
  { name: 'invisible need binding', world: { need: null }, write: true, status: 404, code: 'NOT_FOUND', message: NOT_FOUND },
  { name: 'stale need version', world: { need: { ...OPEN_NEED, version: 2 } }, write: true, status: 409, code: 'NEED_VERSION_CONFLICT', message: NOT_COMPLETED },
  { name: 'covered need', world: { need: { ...OPEN_NEED, status: 'covered' } }, write: true, status: 409, code: 'NEED_NOT_OPEN', message: NOT_COMPLETED },
  {
    name: 'conflicting authoritative units',
    world: { need: { ...OPEN_NEED, sourceRef: `${MAPPING_IDS.installation}:D-1` }, authoritativeUnits: ['box', 'strip'], catalogue: VERIFIED_CATALOGUE },
    write: false, status: 409, code: 'AMBIGUOUS_NEED_UNIT', message: NOT_COMPLETED,
  },
  {
    name: 'concurrent decision',
    world: { need: OPEN_NEED, product: VERIFIED_CATALOGUE[0]!, catalogue: VERIFIED_CATALOGUE, decisionInsertRowCount: 0 },
    write: true, status: 409, code: 'MAPPING_DECISION_CONFLICT', message: NOT_COMPLETED,
  },
  { name: 'unverified pack', world: { need: OPEN_NEED, product: { ...VERIFIED_CATALOGUE[0]!, status: 'review' } }, write: true, status: 422, code: 'CATALOGUE_UNVERIFIED', message: NOT_COMPLETED },
  { name: 'incomplete pack', world: { need: OPEN_NEED, product: VERIFIED_CATALOGUE[2]! }, write: true, status: 422, code: 'CATALOGUE_IDENTITY_INCOMPLETE', message: NOT_COMPLETED },
  {
    name: 'missing supplied unit', world: { need: OPEN_NEED, product: VERIFIED_CATALOGUE[0]! }, write: true,
    payload: { needVersion: 1, productId: MAPPING_IDS.product }, status: 422, code: 'SUPPLIED_UNIT_REQUIRED', message: NOT_COMPLETED,
  },
  {
    name: 'mismatched unit', world: { need: OPEN_NEED, product: VERIFIED_CATALOGUE[0]! }, write: true,
    payload: { ...SELECTION, suppliedUnit: 'strip' }, status: 422, code: 'UNIT_MISMATCH', message: NOT_COMPLETED,
  },
];

type Result = { rows: unknown[]; rowCount: number };

const rows = (values: readonly unknown[]): Result => ({ rows: [...values], rowCount: values.length });
const affected = (count: number): Result => ({ rows: [], rowCount: count });

export function mappingClient(world: MappingWorld): { client: RuntimeClient; statements: string[] } {
  const statements: string[] = [];
  const answer = (text: string): Result => {
    if (world.failure !== undefined) throw world.failure;
    if (/FROM need WHERE id=\$1/.test(text)) return rows(world.need === null ? [] : [world.need]);
    if (/FROM inventory_target/.test(text)) return rows((world.authoritativeUnits ?? []).map((unit) => ({ unit })));
    if (/^SELECT product_id FROM source_product_map WHERE id=\$1$/.test(text)) {
      return rows(world.currentProductId === undefined ? [] : [{ product_id: world.currentProductId }]);
    }
    if (/FROM procurement_product WHERE id=\$1 FOR SHARE/.test(text)) return rows(world.product ? [world.product] : []);
    if (/FROM procurement_product\s+WHERE status='verified'/.test(text)) return rows(world.catalogue ?? []);
    if (/FROM need_mapping_decision decision/.test(text)) return rows(world.existingDecision ? [world.existingDecision] : []);
    if (/^SELECT version FROM source_product_map WHERE id=\$1$/.test(text)) return rows([{ version: world.previousMapVersion ?? 1 }]);
    if (/^INSERT INTO source_product_map/.test(text.trim())) return affected(1);
    if (/^UPDATE need SET source_map_id/.test(text)) return affected(world.needUpdateRowCount ?? 1);
    if (/^INSERT INTO need_mapping_decision/.test(text.trim())) return affected(world.decisionInsertRowCount ?? 1);
    throw new Error(`unscripted statement: ${text.slice(0, 60)}`);
  };
  const client = {
    query: (text: string) => {
      statements.push(text);
      try {
        return Promise.resolve(answer(text));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as RuntimeClient;
  return { client, statements };
}

export function scriptedScope(world: MappingWorld, tenant: TenantContext = mappingContext()): { scope: TenantScope; statements: string[] } {
  const { client, statements } = mappingClient(world);
  const scope: TenantScope = (_request, operation) => operation(client, tenant);
  return { scope, statements };
}

/** Any connection attempt is a defect: only the injected scope may reach the repository. */
export const UNUSABLE_POOL = {
  connect() {
    throw new Error('the mapping boundary reached the database');
  },
} as unknown as Pool;

export const REJECTING_VERIFIER: TokenVerifier = {
  verifyAccessToken: () => Promise.reject(new Error('invalid access token')),
};

export async function withMappingRoutes(
  scope: TenantScope | undefined,
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = buildApp({
    register: (instance) => {
      registerMappingRoutes(instance, UNUSABLE_POOL, REJECTING_VERIFIER, scope === undefined ? {} : { scope });
    },
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}
