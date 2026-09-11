import assert from 'node:assert/strict'
import test from 'node:test'

import { FIXTURE_TIMESTAMP, createSyntheticFixtureSet } from '../src/index.ts'
import { isNonNegativeDecimalString, isPositiveDecimalString } from '../../contracts/src/decimal.ts'

test('generates the same fixture graph on every call', () => {
  assert.deepEqual(createSyntheticFixtureSet(), createSyntheticFixtureSet())
  assert.equal(createSyntheticFixtureSet().generatedAt, FIXTURE_TIMESTAMP)
})

test('returns a fresh, deeply independent graph on every call', () => {
  const first = createSyntheticFixtureSet()
  const second = createSyntheticFixtureSet()

  first.organisations[0].name = 'mutated'
  first.organisations[0].branchIds.push('mutated-branch')
  first.products[0].identifiers.sourceA = 'mutated-code'
  first.scenarios.partialSnapshot.parts[0].records[0].quantity = '999'

  assert.notEqual(second.organisations[0].name, 'mutated')
  assert.equal(second.organisations[0].branchIds.includes('mutated-branch'), false)
  assert.notEqual(second.products[0].identifiers.sourceA, 'mutated-code')
  assert.notEqual(second.scenarios.partialSnapshot.parts[0].records[0].quantity, '999')
})

test('contains the required organisations, branches, roles, and invented packs', () => {
  const fixtures = createSyntheticFixtureSet()
  const pharmacies = fixtures.organisations.filter(({ kind }) => kind === 'pharmacy')
  const suppliers = fixtures.organisations.filter(({ kind }) => kind === 'supplier')

  assert.equal(pharmacies.length, 2)
  assert.equal(suppliers.length, 2)
  assert.equal(fixtures.branches.length, 4)
  assert.deepEqual(pharmacies.map(({ branchIds }) => branchIds.length), [2, 2])
  assert.deepEqual(new Set(fixtures.memberships.map(({ role }) => role)), new Set(['pharmacy_owner', 'purchaser', 'receiver']))
  assert.equal(fixtures.products.length, 30)
  assert.equal(fixtures.products.every(({ synthetic }) => synthetic), true)
})

test('maintains referential integrity across the fixture graph', () => {
  const fixtures = createSyntheticFixtureSet()
  const organisationIds = new Set(fixtures.organisations.map(({ id }) => id))
  const branchIds = new Set(fixtures.branches.map(({ id }) => id))
  const productIds = new Set(fixtures.products.map(({ id }) => id))
  const relationshipIds = new Set(fixtures.relationships.map(({ id }) => id))

  for (const branch of fixtures.branches) assert.equal(organisationIds.has(branch.organisationId), true)
  for (const membership of fixtures.memberships) {
    assert.equal(organisationIds.has(membership.organisationId), true)
    for (const branchId of membership.branchScope) assert.equal(branchIds.has(branchId), true)
  }
  for (const relationship of fixtures.relationships) {
    assert.equal(organisationIds.has(relationship.pharmacyOrganisationId), true)
    assert.equal(organisationIds.has(relationship.supplierOrganisationId), true)
    for (const branchId of relationship.branchScope) assert.equal(branchIds.has(branchId), true)
  }
  for (const offer of fixtures.offers) {
    assert.equal(relationshipIds.has(offer.relationshipId), true)
    assert.equal(productIds.has(offer.productId), true)
  }
})

test('all fixture entity IDs are canonical UUIDs', () => {
  const fixtures = createSyntheticFixtureSet()
  const entities = [fixtures.organisations, fixtures.branches, fixtures.memberships,
    fixtures.products, fixtures.relationships, fixtures.offers].flat()
  for (const entity of entities) {
    assert.match(entity.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
})

test('models ambiguous strengths without collapsing product identity', () => {
  const { ambiguousStrengthPair } = createSyntheticFixtureSet().scenarios
  assert.equal(ambiguousStrengthPair.sourceDescription, 'Synthora tablets')
  assert.equal(ambiguousStrengthPair.reviewRequired, true)
  assert.equal(ambiguousStrengthPair.candidateProductIds.length, 2)
  assert.notEqual(ambiguousStrengthPair.candidateProductIds[0], ambiguousStrengthPair.candidateProductIds[1])
})

test('models account-specific active offers and an expired offer', () => {
  const fixtures = createSyntheticFixtureSet()
  const active = fixtures.offers.filter(({ status }) => status === 'active')
  const expired = fixtures.offers.filter(({ status }) => status === 'expired')

  assert.equal(fixtures.relationships.every(({ status }) => status === 'active'), true)
  assert.equal(active.length >= 4, true)
  assert.equal(expired.length, 1)
  assert.equal(new Set(active.map(({ relationshipId }) => relationshipId)).size >= 2, true)
  assert.equal(fixtures.offers.every(({ price, availableQuantity }) => isPositiveDecimalString(price) && isNonNegativeDecimalString(availableQuantity)), true)
  assert.equal(expired[0].validUntil < FIXTURE_TIMESTAMP, true)
})

test('models an incomplete multipart snapshot that cannot erase prior stock', () => {
  const scenario = createSyntheticFixtureSet().scenarios.partialSnapshot

  assert.equal(scenario.expectedPartitions, 2)
  assert.equal(scenario.parts.length, 1)
  assert.equal(scenario.completionMarkerReceived, false)
  assert.equal(scenario.previousObservation.quantity, '12')
  assert.equal(scenario.expectedProjection.quantity, '12')
  assert.equal(scenario.expectedProjection.freshness, 'stale')
})
