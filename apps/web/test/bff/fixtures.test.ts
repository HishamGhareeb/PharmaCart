import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_NEED_ID,
  SYNTHETIC_SALE_UNIT,
  SYNTHETIC_SCOPES,
  SYNTHETIC_SUPPLIERS,
  findScopeOption,
  findSupplierOption,
} from '../../src/lib/fixtures.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const seed = readFileSync(new URL('../../../../packages/db/scripts/seed-local.ts', import.meta.url), 'utf8');
const provider = readFileSync(new URL('../../../../infra/oidc/provider.ts', import.meta.url), 'utf8');

describe('synthetic fixture selectors', () => {
  it('offers only canonical UUID scopes with unique identifiers', () => {
    expect(SYNTHETIC_SCOPES.length).toBeGreaterThanOrEqual(2);
    for (const scope of SYNTHETIC_SCOPES) {
      expect(scope.organisationId).toMatch(UUID);
      expect(scope.branchId).toMatch(UUID);
      expect(scope.label.length).toBeGreaterThan(0);
      expect(scope.expectedSubject).toMatch(/^synthetic:/);
    }
    const keys = SYNTHETIC_SCOPES.map((scope) => `${scope.organisationId}:${scope.branchId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('matches the identifiers that the local seed script actually inserts', () => {
    for (const scope of SYNTHETIC_SCOPES) {
      expect(seed).toContain(scope.organisationId);
      expect(seed).toContain(scope.branchId);
    }
    for (const supplier of SYNTHETIC_SUPPLIERS.filter((option) => option.supplierId !== null)) {
      expect(seed).toContain(supplier.supplierId as string);
    }
    expect(seed).toContain(SYNTHETIC_NEED_ID);
  });

  it('documents that only the box sale unit exists in the seeded catalogue', () => {
    expect(SYNTHETIC_SALE_UNIT).toBe('box');
    expect(seed).toContain("saleUnit:'box'");
  });

  it('resolves only allowlisted scope and supplier selections', () => {
    const first = SYNTHETIC_SCOPES[0]!;
    expect(findScopeOption(first.organisationId, first.branchId)).toEqual(first);
    expect(findScopeOption(first.organisationId, SYNTHETIC_SCOPES[1]!.branchId)).toBeUndefined();
    expect(findScopeOption('00000000-0000-4000-8000-000000000000', first.branchId)).toBeUndefined();
    expect(findSupplierOption('unknown-supplier-key')).toBeUndefined();
    expect(findSupplierOption(SYNTHETIC_SUPPLIERS[0]!.key)).toEqual(SYNTHETIC_SUPPLIERS[0]);
  });

  it('includes an any-supplier option that sends an empty constraint list', () => {
    const any = SYNTHETIC_SUPPLIERS.find((option) => option.supplierId === null);
    expect(any, 'an unconstrained supplier option must exist').toBeDefined();
  });
});

describe('local OIDC registration for the web loop', () => {
  it('registers a separate public web client with the 3001 callback', () => {
    expect(provider).toContain("client_id: 'pharmacart-web-local'");
    expect(provider).toContain("'http://127.0.0.1:3001/auth/callback'");
  });

  it('leaves the existing API client and its callback untouched', () => {
    expect(provider).toContain("client_id: 'pharmacart-local'");
    expect(provider).toContain("'http://127.0.0.1:3000/auth/callback'");
  });

  it('keeps both clients public authorization-code clients with PKCE required', () => {
    expect(provider.match(/token_endpoint_auth_method: 'none'/g)?.length).toBe(2);
    expect(provider.match(/grant_types: \['authorization_code'\]/g)?.length).toBe(2);
    expect(provider).toContain('pkce: { required: () => true }');
  });

  it('never places a client secret in the local provider source', () => {
    expect(provider).not.toMatch(/client_secret/);
  });
});
