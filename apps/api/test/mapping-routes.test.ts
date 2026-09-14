import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { buildApp } from '../src/app.ts';
import { registerMappingRoutes } from '../src/mapping-routes.ts';
import type { TokenVerifier } from '../src/tenant-api.ts';
import {
  assertMappingReadAllowed,
  assertMappingWriteAllowed,
  buildCandidatesView,
  MappingError,
  MAX_MAPPING_CANDIDATES,
  readCatalogueIdentity,
  resolveMappingUnit,
  type CatalogueRow,
} from '../../../packages/db/src/mapping.ts';
import type { MembershipRole, OrganisationKind, TenantContext } from '../../../packages/db/src/runtime.ts';

const NEED_ID = '40000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '60000000-0000-4000-8000-000000000001';
const OTHER_PRODUCT_ID = '60000000-0000-4000-8000-000000000002';

// Any connection attempt is a defect in these tests: every case below must be refused at the
// request boundary, before a tenant transaction is opened.
const unusablePool = {
  connect() {
    throw new Error('the mapping boundary reached the database');
  },
} as unknown as Pool;

const rejectingVerifier: TokenVerifier = {
  verifyAccessToken: async () => {
    throw new Error('invalid access token');
  },
};

function mappingApp(verifier: TokenVerifier = rejectingVerifier) {
  return buildApp({ register: (app) => { registerMappingRoutes(app, unusablePool, verifier); } });
}

function packIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function catalogueRow(id: string, overrides: Partial<CatalogueRow> = {}): CatalogueRow {
  return { id, status: 'verified', identity: packIdentity(), ...overrides };
}

const openNeed = { id: NEED_ID, version: 3, status: 'open', productRef: 'SYN-A', currentProductId: null };

function tenantContext(role: MembershipRole, organisationKind: OrganisationKind = 'pharmacy'): TenantContext {
  return {
    principalKind: 'member',
    userSubject: 'synthetic:user:a',
    membershipId: '30000000-0000-4000-8000-000000000001',
    organisationId: '10000000-0000-4000-8000-000000000001',
    organisationKind,
    branchId: '20000000-0000-4000-8000-000000000001',
    allowedBranchIds: ['20000000-0000-4000-8000-000000000001'],
    role,
    membershipVersion: 1,
  };
}

function refusal(operation: () => unknown): MappingError {
  try {
    operation();
  } catch (error) {
    assert(error instanceof MappingError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: 'the operation was expected to be refused' });
}

test('mapping routes refuse unauthenticated callers before any database work', async () => {
  const app = mappingApp();
  try {
    const candidates = await app.inject({ url: `/v1/needs/${NEED_ID}/mapping-candidates` });
    assert.equal(candidates.statusCode, 401);
    assert.equal(candidates.json().error.code, 'UNAUTHENTICATED');

    const anonymousWrite = await app.inject({
      method: 'POST',
      url: `/v1/needs/${NEED_ID}/mapping`,
      payload: { needVersion: 1, productId: PRODUCT_ID },
    });
    assert.equal(anonymousWrite.statusCode, 401);

    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/needs/${NEED_ID}/mapping`,
      headers: { authorization: 'Bearer synthetic-not-a-real-token' },
      payload: { needVersion: 1, productId: PRODUCT_ID },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error.code, 'UNAUTHENTICATED');
    assert.doesNotMatch(rejected.body, /synthetic-not-a-real-token|invalid access token/);
  } finally {
    await app.close();
  }
});

test('the mapping command schema refuses unknown, malformed and unbounded fields without echoing them', async () => {
  const app = mappingApp();
  const rejected: readonly Record<string, unknown>[] = [
    {},
    { productId: PRODUCT_ID },
    { needVersion: 1 },
    { needVersion: 0, productId: PRODUCT_ID },
    { needVersion: -1, productId: PRODUCT_ID },
    { needVersion: 1.5, productId: PRODUCT_ID },
    { needVersion: '1', productId: PRODUCT_ID },
    { needVersion: 1, productId: 'SYN Brand 5 mg' },
    { needVersion: 1, productId: '6000000A-0000-4000-8000-00000000000B' },
    { needVersion: 1, productId: `${PRODUCT_ID} ` },
    { needVersion: 1, productId: PRODUCT_ID, suppliedUnit: '' },
    { needVersion: 1, productId: PRODUCT_ID, suppliedUnit: 'x'.repeat(33) },
    { needVersion: 1, productId: PRODUCT_ID, suppliedUnit: 7 },
    { needVersion: 1, productId: PRODUCT_ID, organisationId: '10000000-0000-4000-8000-000000000002' },
    { needVersion: 1, productId: PRODUCT_ID, autoSelect: true },
    { needVersion: 1, productId: [PRODUCT_ID] },
  ];
  try {
    for (const payload of rejected) {
      const response = await app.inject({ method: 'POST', url: `/v1/needs/${NEED_ID}/mapping`, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().error.code, 'INVALID_REQUEST', JSON.stringify(payload));
      assert.doesNotMatch(response.body, /autoSelect|organisationId|SYN Brand/);
    }
  } finally {
    await app.close();
  }
});

test('an unparseable mapping command never reaches the repository', async () => {
  const app = mappingApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/needs/${NEED_ID}/mapping`,
      headers: { 'content-type': 'application/json' },
      payload: '{"needVersion":1,',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_JSON');
  } finally {
    await app.close();
  }
});

test('a catalogue identity is selectable only when it is complete and canonical', () => {
  assert.deepEqual(readCatalogueIdentity(packIdentity()), {
    brand: 'SYN Brand',
    manufacturer: 'SYN Maker',
    strength: '5 mg',
    dosageForm: 'tablet',
    packSize: { value: '20', unit: 'tablet' },
    saleUnit: 'box',
  });

  for (const incomplete of [
    packIdentity({ manufacturer: undefined }),
    packIdentity({ strength: '' }),
    packIdentity({ dosageForm: '   ' }),
    packIdentity({ saleUnit: ' box ' }),
    packIdentity({ brand: 42 }),
    packIdentity({ packSize: undefined }),
    packIdentity({ packSize: { value: '20' } }),
    packIdentity({ packSize: { value: '0', unit: 'tablet' } }),
    packIdentity({ packSize: { value: '20.0', unit: 'tablet' } }),
    packIdentity({ packSize: { value: 'twenty', unit: 'tablet' } }),
    packIdentity({ packSize: { value: '20', unit: '' } }),
  ]) {
    assert.equal(readCatalogueIdentity(incomplete), null, JSON.stringify(incomplete));
  }

  for (const value of [null, undefined, 'SYN Brand', 7, [packIdentity()]]) {
    assert.equal(readCatalogueIdentity(value), null, JSON.stringify(value));
  }
});

test('mapping units are matched exactly and are never converted between pack units', () => {
  assert.deepEqual(
    resolveMappingUnit({ authoritativeUnit: 'box', suppliedUnit: undefined, saleUnit: 'box' }),
    { unit: 'box', basis: 'authoritative_metadata' },
  );
  assert.deepEqual(
    resolveMappingUnit({ authoritativeUnit: 'box', suppliedUnit: 'box', saleUnit: 'box' }),
    { unit: 'box', basis: 'authoritative_metadata' },
  );
  assert.deepEqual(
    resolveMappingUnit({ authoritativeUnit: null, suppliedUnit: 'box', saleUnit: 'box' }),
    { unit: 'box', basis: 'explicit_supplied_unit' },
  );

  const missing = refusal(() => resolveMappingUnit({ authoritativeUnit: null, suppliedUnit: undefined, saleUnit: 'box' }));
  assert.equal(missing.status, 422);
  assert.equal(missing.code, 'SUPPLIED_UNIT_REQUIRED');

  for (const input of [
    { authoritativeUnit: 'strip', suppliedUnit: undefined, saleUnit: 'box' },
    { authoritativeUnit: 'box', suppliedUnit: 'strip', saleUnit: 'box' },
    { authoritativeUnit: null, suppliedUnit: 'strip', saleUnit: 'box' },
    { authoritativeUnit: null, suppliedUnit: 'Box', saleUnit: 'box' },
    { authoritativeUnit: null, suppliedUnit: 'boxes', saleUnit: 'box' },
  ] as const) {
    const mismatch = refusal(() => resolveMappingUnit(input));
    assert.equal(mismatch.status, 422, JSON.stringify(input));
    assert.equal(mismatch.code, 'UNIT_MISMATCH', JSON.stringify(input));
  }
});

test('candidate views always require an explicit selection and never disclose account pricing', () => {
  const view = buildCandidatesView({
    need: openNeed,
    authoritativeUnit: null,
    rows: [
      catalogueRow(OTHER_PRODUCT_ID, { identity: packIdentity({ strength: '10 mg' }) }),
      catalogueRow(PRODUCT_ID),
    ],
  });

  assert.equal(view.selectionRequired, true);
  assert.equal(view.ambiguous, true);
  assert.equal(view.unitBasis, 'explicit_supplied_unit_required');
  assert.equal(view.authoritativeUnit, null);
  assert.equal(view.truncated, false);
  assert.equal(view.unselectableExcluded, 0);
  assert.deepEqual(view.candidates.map((candidate) => candidate.productId), [PRODUCT_ID, OTHER_PRODUCT_ID]);
  assert.deepEqual(view.candidates.map((candidate) => candidate.identity.strength), ['5 mg', '10 mg']);
  assert.doesNotMatch(JSON.stringify(view), /price|currency|EGP|offer|supplier|selected|chosen/i);

  const single = buildCandidatesView({ need: openNeed, authoritativeUnit: null, rows: [catalogueRow(PRODUCT_ID)] });
  assert.equal(single.ambiguous, false);
  assert.equal(single.selectionRequired, true);
  assert.equal(single.currentProductId, null);
});

test('candidate views exclude unverified, incomplete and unit-inconsistent catalogue rows', () => {
  const view = buildCandidatesView({
    need: openNeed,
    authoritativeUnit: null,
    rows: [
      catalogueRow(PRODUCT_ID),
      catalogueRow('60000000-0000-4000-8000-000000000003', { status: 'review' }),
      catalogueRow('60000000-0000-4000-8000-000000000004', { identity: packIdentity({ manufacturer: '' }) }),
    ],
  });
  assert.deepEqual(view.candidates.map((candidate) => candidate.productId), [PRODUCT_ID]);
  assert.equal(view.unselectableExcluded, 2);

  const byUnit = buildCandidatesView({
    need: openNeed,
    authoritativeUnit: 'box',
    rows: [
      catalogueRow(PRODUCT_ID),
      catalogueRow(OTHER_PRODUCT_ID, { identity: packIdentity({ saleUnit: 'strip' }) }),
    ],
  });
  assert.equal(byUnit.unitBasis, 'authoritative_metadata');
  assert.equal(byUnit.authoritativeUnit, 'box');
  assert.deepEqual(byUnit.candidates.map((candidate) => candidate.productId), [PRODUCT_ID]);

  const noneEligible = buildCandidatesView({
    need: openNeed,
    authoritativeUnit: 'strip',
    rows: [catalogueRow(PRODUCT_ID)],
  });
  assert.deepEqual(noneEligible.candidates, []);
  assert.equal(noneEligible.ambiguous, false);
  assert.equal(noneEligible.selectionRequired, true);
});

test('candidate views stay bounded and report truncation instead of silently dropping rows', () => {
  const rows = Array.from({ length: MAX_MAPPING_CANDIDATES + 1 }, (_unused, index) =>
    catalogueRow(`60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`));

  const view = buildCandidatesView({ need: openNeed, authoritativeUnit: null, rows });
  assert.equal(view.candidates.length, MAX_MAPPING_CANDIDATES);
  assert.equal(view.truncated, true);
  assert.equal(view.ambiguous, true);
  assert.equal(view.candidates.at(-1)?.productId, rows[MAX_MAPPING_CANDIDATES - 1]?.id);
});

test('only a pharmacy owner may bind a mapping while a purchaser may still read candidates', () => {
  assertMappingReadAllowed(tenantContext('pharmacy_owner'));
  assertMappingReadAllowed(tenantContext('purchaser'));
  assertMappingWriteAllowed(tenantContext('pharmacy_owner'));

  const purchaser = refusal(() => { assertMappingWriteAllowed(tenantContext('purchaser')); });
  assert.equal(purchaser.status, 403);
  assert.equal(purchaser.code, 'FORBIDDEN');

  for (const role of ['receiver', 'support', 'supplier_operator', 'supplier_administrator'] as const) {
    assert.equal(refusal(() => { assertMappingReadAllowed(tenantContext(role)); }).status, 403);
    assert.equal(refusal(() => { assertMappingWriteAllowed(tenantContext(role)); }).status, 403);
  }

  assert.equal(refusal(() => { assertMappingReadAllowed(tenantContext('pharmacy_owner', 'supplier')); }).code, 'FORBIDDEN');
  assert.equal(refusal(() => { assertMappingWriteAllowed(tenantContext('pharmacy_owner', 'supplier')); }).code, 'FORBIDDEN');
});

