/**
 * Explicit synthetic fixture selectors.
 *
 * The API has no listing endpoint for organisations, branches, suppliers or needs, and no unit
 * metadata endpoint. Rather than invent backend data, this app offers a small fixed allowlist that
 * mirrors packages/db/scripts/seed-local.ts. Anything outside this list is refused before a request
 * is made; the API still enforces membership, so a wrong pairing is refused there too.
 */

export type ScopeOption = Readonly<{
  key: string;
  label: string;
  organisationId: string;
  branchId: string;
  /** The synthetic OIDC subject seeded with an active membership for this scope. */
  expectedSubject: string;
  seededRole: string;
}>;

export type SupplierOption = Readonly<{
  key: string;
  label: string;
  supplierId: string | null;
}>;

export const SYNTHETIC_SCOPES: readonly ScopeOption[] = Object.freeze([
  Object.freeze({
    key: 'synthetic-a',
    label: 'Synthetic A (pharmacy) - Synthetic A branch',
    organisationId: '10000000-0000-4000-8000-000000000001',
    branchId: '20000000-0000-4000-8000-000000000001',
    expectedSubject: 'synthetic:user:a',
    seededRole: 'pharmacy_owner',
  }),
  Object.freeze({
    key: 'synthetic-b',
    label: 'Synthetic B (pharmacy) - Synthetic B branch',
    organisationId: '10000000-0000-4000-8000-000000000002',
    branchId: '20000000-0000-4000-8000-000000000002',
    expectedSubject: 'synthetic:user:b',
    seededRole: 'purchaser',
  }),
]);

export const SYNTHETIC_SUPPLIERS: readonly SupplierOption[] = Object.freeze([
  Object.freeze({
    key: 'synthetic-supplier',
    label: 'Synthetic Supplier (seeded relationship)',
    supplierId: '10000000-0000-4000-8000-000000000003',
  }),
  Object.freeze({
    key: 'any',
    label: 'Any supplier with an active relationship',
    supplierId: null,
  }),
]);

/** The seeded catalogue only carries a box sale unit, so quotes are box-only by construction. */
export const SYNTHETIC_SALE_UNIT = 'box';

/** The single need inserted by the local seed script; any other need UUID may still be typed in. */
export const SYNTHETIC_NEED_ID = '40000000-0000-4000-8000-000000000001';

export function findScopeOption(organisationId: unknown, branchId: unknown): ScopeOption | undefined {
  return SYNTHETIC_SCOPES.find(
    (option) => option.organisationId === organisationId && option.branchId === branchId,
  );
}

export function findSupplierOption(key: unknown): SupplierOption | undefined {
  return SYNTHETIC_SUPPLIERS.find((option) => option.key === key);
}

export function scopeLabel(organisationId: string, branchId: string): string {
  return findScopeOption(organisationId, branchId)?.label ?? `${organisationId} / ${branchId}`;
}
