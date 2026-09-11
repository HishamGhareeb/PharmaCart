import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideCommercialPackMapping,
  type CommercialPack,
  type SourcePackIdentity,
} from '../src/commercial-pack-mapping.ts';

const packs: readonly CommercialPack[] = [
  {
    id: 'pack-10',
    brand: 'Syntheticol',
    manufacturer: 'Demo Labs',
    strength: '10 mg',
    dosageForm: 'tablet',
    packSize: { value: '20', unit: 'tablet' },
    saleUnit: 'box',
    identityStatus: 'verified',
    verifiedIdentifiers: [{ scheme: 'gtin', value: '000123', verificationStatus: 'verified' }],
  },
  {
    id: 'pack-20',
    brand: 'Syntheticol',
    manufacturer: 'Demo Labs',
    strength: '20 mg',
    dosageForm: 'tablet',
    packSize: { value: '20', unit: 'tablet' },
    saleUnit: 'box',
    identityStatus: 'verified',
    verifiedIdentifiers: [{ scheme: 'gtin', value: '000124', verificationStatus: 'verified' }],
  },
];

const exactSource: SourcePackIdentity = {
  identifiers: [{ scheme: 'gtin', value: '000123' }],
  brand: 'Syntheticol',
  manufacturer: 'Demo Labs',
  strength: '10 mg',
  dosageForm: 'tablet',
  packSize: { value: '20', unit: 'tablet' },
  saleUnit: 'box',
};

describe('verified commercial-pack mapping', () => {
  it('approves one exact verified identifier and full pack identity match', () => {
    assert.deepEqual(decideCommercialPackMapping(exactSource, packs), {
      kind: 'approved',
      productId: 'pack-10',
    });
  });

  it('holds ambiguous same-brand text with no verified identifier for review', () => {
    const result = decideCommercialPackMapping(
      { ...exactSource, identifiers: [], strength: undefined },
      packs,
    );
    assert.equal(result.kind, 'review');
    assert.equal(result.reason, 'missing_required_identity');
  });

  it('holds identifier matches with a different strength, form, manufacturer, pack, or sale unit', () => {
    const mismatches: readonly Partial<SourcePackIdentity>[] = [
      { strength: '20 mg' },
      { dosageForm: 'capsule' },
      { manufacturer: 'Other Labs' },
      { packSize: { value: '10', unit: 'tablet' } },
      { saleUnit: 'bottle' },
    ];

    for (const mismatch of mismatches) {
      assert.deepEqual(decideCommercialPackMapping({ ...exactSource, ...mismatch }, packs), {
        kind: 'review',
        reason: 'identity_mismatch',
        candidateProductIds: ['pack-10'],
      });
    }
  });

  it('requires an explicitly verified identifier and verified product status', () => {
    const unverifiedIdentifier: CommercialPack = {
      ...packs[0]!,
      verifiedIdentifiers: [{ scheme: 'gtin', value: '000123', verificationStatus: 'unverified' }],
    };
    const underReview: CommercialPack = { ...packs[0]!, identityStatus: 'under_review' };

    assert.equal(decideCommercialPackMapping(exactSource, [unverifiedIdentifier]).kind, 'review');
    assert.equal(decideCommercialPackMapping(exactSource, [underReview]).kind, 'review');
  });

  it('preserves opaque identifiers including leading zeroes', () => {
    assert.equal(
      decideCommercialPackMapping(
        { ...exactSource, identifiers: [{ scheme: 'gtin', value: '123' }] },
        packs,
      ).kind,
      'review',
    );
  });

  it('holds multiple exact verified candidates for review', () => {
    const duplicateIdentity = { ...packs[0]!, id: 'pack-duplicate' };
    assert.deepEqual(decideCommercialPackMapping(exactSource, [...packs, duplicateIdentity]), {
      kind: 'review',
      reason: 'ambiguous_verified_match',
      candidateProductIds: ['pack-10', 'pack-duplicate'],
    });
  });

  it('rejects noncanonical or nonpositive pack-size values as missing identity', () => {
    for (const value of ['20.0', '0', '-1']) {
      assert.equal(
        decideCommercialPackMapping({ ...exactSource, packSize: { value, unit: 'tablet' } }, packs).kind,
        'review',
      );
    }
  });
});
