export const FIXTURE_TIMESTAMP = '2026-09-11T10:00:00.000Z'

type OrganisationKind = 'pharmacy' | 'supplier'
type MemberRole = 'pharmacy_owner' | 'purchaser' | 'receiver'

export type SyntheticOrganisation = {
  id: string
  kind: OrganisationKind
  name: string
  branchIds: string[]
  synthetic: true
}

export type SyntheticBranch = {
  id: string
  organisationId: string
  name: string
  timezone: string
  externalRef: string
}

export type SyntheticMembership = {
  id: string
  organisationId: string
  userSubject: string
  role: MemberRole
  branchScope: string[]
  status: 'active'
}

export type SyntheticProduct = {
  id: string
  brand: string
  manufacturer: string
  strength: string
  dosageForm: string
  packSize: string
  baseUnit: string
  identifiers: { sourceA: string; sourceB: string }
  synthetic: true
}

export type SyntheticRelationship = {
  id: string
  pharmacyOrganisationId: string
  supplierOrganisationId: string
  accountRef: string
  branchScope: string[]
  status: 'active'
  termsVersion: number
}

export type SyntheticOffer = {
  id: string
  relationshipId: string
  productId: string
  availableQuantity: string
  price: string
  currency: 'EGP'
  priceBasis: 'box'
  validUntil: string
  status: 'active' | 'expired'
}

type SnapshotRecord = {
  sourceCode: string
  unit: 'box'
  quantityKind: 'available'
  quantity: string
}

export type SyntheticFixtureSet = {
  fixtureVersion: '1.0.0'
  generatedAt: typeof FIXTURE_TIMESTAMP
  organisations: SyntheticOrganisation[]
  branches: SyntheticBranch[]
  memberships: SyntheticMembership[]
  products: SyntheticProduct[]
  relationships: SyntheticRelationship[]
  offers: SyntheticOffer[]
  scenarios: {
    ambiguousStrengthPair: {
      sourceDescription: string
      candidateProductIds: string[]
      reviewRequired: true
    }
    partialSnapshot: {
      snapshotId: string
      expectedPartitions: number
      completionMarkerReceived: false
      parts: Array<{ partition: number; records: SnapshotRecord[] }>
      previousObservation: { productId: string; quantity: string; observedAt: string }
      expectedProjection: { productId: string; quantity: string; freshness: 'stale' }
    }
  }
}

const ids = {
  pharmacyA: '00000000-0000-4000-8000-000000000001',
  pharmacyB: '00000000-0000-4000-8000-000000000002',
  supplierA: '00000000-0000-4000-8000-000000000003',
  supplierB: '00000000-0000-4000-8000-000000000004',
  branchA1: '00000000-0000-4000-8000-000000000101',
  branchA2: '00000000-0000-4000-8000-000000000102',
  branchB1: '00000000-0000-4000-8000-000000000103',
  branchB2: '00000000-0000-4000-8000-000000000104',
}

function numberedUuid(group: string, number: number): string {
  return `00000000-0000-4${group}-8${group}-${String(number).padStart(12, '0')}`
}

const organisations: SyntheticOrganisation[] = [
  { id: ids.pharmacyA, kind: 'pharmacy', name: 'Example Cedar Pharmacy', branchIds: [ids.branchA1, ids.branchA2], synthetic: true },
  { id: ids.pharmacyB, kind: 'pharmacy', name: 'Example Harbor Pharmacy', branchIds: [ids.branchB1, ids.branchB2], synthetic: true },
  { id: ids.supplierA, kind: 'supplier', name: 'Example North Supplier', branchIds: [], synthetic: true },
  { id: ids.supplierB, kind: 'supplier', name: 'Example South Supplier', branchIds: [], synthetic: true },
]

const branches: SyntheticBranch[] = [
  { id: ids.branchA1, organisationId: ids.pharmacyA, name: 'Cedar East', timezone: 'Africa/Cairo', externalRef: 'SYN-PHA-01' },
  { id: ids.branchA2, organisationId: ids.pharmacyA, name: 'Cedar West', timezone: 'Africa/Cairo', externalRef: 'SYN-PHA-02' },
  { id: ids.branchB1, organisationId: ids.pharmacyB, name: 'Harbor North', timezone: 'Africa/Cairo', externalRef: 'SYN-PHB-01' },
  { id: ids.branchB2, organisationId: ids.pharmacyB, name: 'Harbor South', timezone: 'Africa/Cairo', externalRef: 'SYN-PHB-02' },
]

const memberships: SyntheticMembership[] = [
  { id: numberedUuid('110', 1), organisationId: ids.pharmacyA, userSubject: 'synthetic:user:owner-a', role: 'pharmacy_owner', branchScope: [ids.branchA1, ids.branchA2], status: 'active' },
  { id: numberedUuid('110', 2), organisationId: ids.pharmacyA, userSubject: 'synthetic:user:purchaser-a', role: 'purchaser', branchScope: [ids.branchA1], status: 'active' },
  { id: numberedUuid('110', 3), organisationId: ids.pharmacyA, userSubject: 'synthetic:user:receiver-a', role: 'receiver', branchScope: [ids.branchA1], status: 'active' },
  { id: numberedUuid('110', 4), organisationId: ids.pharmacyB, userSubject: 'synthetic:user:owner-b', role: 'pharmacy_owner', branchScope: [ids.branchB1, ids.branchB2], status: 'active' },
  { id: numberedUuid('110', 5), organisationId: ids.pharmacyB, userSubject: 'synthetic:user:purchaser-b', role: 'purchaser', branchScope: [ids.branchB1], status: 'active' },
  { id: numberedUuid('110', 6), organisationId: ids.pharmacyB, userSubject: 'synthetic:user:receiver-b', role: 'receiver', branchScope: [ids.branchB1], status: 'active' },
]

const forms = ['tablet', 'capsule', 'syrup', 'cream', 'drops']
const products: SyntheticProduct[] = Array.from({ length: 30 }, (_, index) => {
  const number = index + 1
  const ambiguous = index < 2
  return {
    id: numberedUuid('220', number),
    brand: ambiguous ? 'Synthora' : `Inventamed ${String(number).padStart(2, '0')}`,
    manufacturer: `Fictional Works ${((index % 4) + 1).toString()}`,
    strength: ambiguous ? (index === 0 ? '10 mg' : '20 mg') : `${(index % 8) + 1} mg`,
    dosageForm: ambiguous ? 'tablet' : forms[index % forms.length],
    packSize: `${10 + (index % 3) * 10} ${index % 2 === 0 ? 'units' : 'mL'}`,
    baseUnit: index % 2 === 0 ? 'unit' : 'mL',
    identifiers: {
      sourceA: String(1000 + number).padStart(6, '0'),
      sourceB: `SYN-B-${String(number).padStart(4, '0')}`,
    },
    synthetic: true,
  }
})

const relationships: SyntheticRelationship[] = [
  { id: numberedUuid('330', 1), pharmacyOrganisationId: ids.pharmacyA, supplierOrganisationId: ids.supplierA, accountRef: 'SYN-ACCOUNT-A-NORTH', branchScope: [ids.branchA1, ids.branchA2], status: 'active', termsVersion: 1 },
  { id: numberedUuid('330', 2), pharmacyOrganisationId: ids.pharmacyA, supplierOrganisationId: ids.supplierB, accountRef: 'SYN-ACCOUNT-A-SOUTH', branchScope: [ids.branchA1], status: 'active', termsVersion: 2 },
  { id: numberedUuid('330', 3), pharmacyOrganisationId: ids.pharmacyB, supplierOrganisationId: ids.supplierA, accountRef: 'SYN-ACCOUNT-B-NORTH', branchScope: [ids.branchB1, ids.branchB2], status: 'active', termsVersion: 1 },
  { id: numberedUuid('330', 4), pharmacyOrganisationId: ids.pharmacyB, supplierOrganisationId: ids.supplierB, accountRef: 'SYN-ACCOUNT-B-SOUTH', branchScope: [ids.branchB2], status: 'active', termsVersion: 3 },
]

const offers: SyntheticOffer[] = relationships.map((relationship, index) => ({
  id: numberedUuid('440', index + 1),
  relationshipId: relationship.id,
  productId: products[index % products.length].id,
  availableQuantity: `${20 + index}`,
  price: `${100 + index * 7}.5`,
  currency: 'EGP',
  priceBasis: 'box',
  validUntil: '2026-09-11T11:00:00.000Z',
  status: 'active',
}))

offers.push({
  id: numberedUuid('440', 5),
  relationshipId: relationships[0].id,
  productId: products[4].id,
  availableQuantity: '8',
  price: '88.25',
  currency: 'EGP',
  priceBasis: 'box',
  validUntil: '2026-09-11T09:59:59.000Z',
  status: 'expired',
})

const fixtureTemplate: SyntheticFixtureSet = {
  fixtureVersion: '1.0.0',
  generatedAt: FIXTURE_TIMESTAMP,
  organisations,
  branches,
  memberships,
  products,
  relationships,
  offers,
  scenarios: {
    ambiguousStrengthPair: {
      sourceDescription: 'Synthora tablets',
      candidateProductIds: [products[0].id, products[1].id],
      reviewRequired: true,
    },
    partialSnapshot: {
      snapshotId: 'synthetic-snapshot-0002',
      expectedPartitions: 2,
      completionMarkerReceived: false,
      parts: [{
        partition: 1,
        records: [{ sourceCode: products[1].identifiers.sourceA, unit: 'box', quantityKind: 'available', quantity: '7' }],
      }],
      previousObservation: { productId: products[0].id, quantity: '12', observedAt: '2026-09-11T09:00:00.000Z' },
      expectedProjection: { productId: products[0].id, quantity: '12', freshness: 'stale' },
    },
  },
}

export function createSyntheticFixtureSet(): SyntheticFixtureSet {
  return structuredClone(fixtureTemplate)
}

