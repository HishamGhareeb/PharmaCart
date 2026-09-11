import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';

export type PackSize = Readonly<{ value: string; unit: string }>;

export type SourcePackIdentity = Readonly<{
  identifiers: readonly Readonly<{ scheme: string; value: string }>[];
  brand: string | undefined;
  manufacturer: string | undefined;
  strength: string | undefined;
  dosageForm: string | undefined;
  packSize: PackSize | undefined;
  saleUnit: string | undefined;
}>;

export type CommercialPack = Readonly<{
  id: string;
  brand: string;
  manufacturer: string;
  strength: string;
  dosageForm: string;
  packSize: PackSize;
  saleUnit: string;
  identityStatus: 'verified' | 'under_review' | 'quarantined';
  verifiedIdentifiers: readonly Readonly<{
    scheme: string;
    value: string;
    verificationStatus: 'verified' | 'unverified';
  }>[];
}>;

export type CommercialPackMappingDecision =
  | Readonly<{ kind: 'approved'; productId: string }>
  | Readonly<{
      kind: 'review';
      reason: 'missing_required_identity' | 'no_verified_identifier_match';
    }>
  | Readonly<{
      kind: 'review';
      reason: 'identity_mismatch' | 'ambiguous_verified_match';
      candidateProductIds: readonly string[];
    }>;

export function decideCommercialPackMapping(
  source: SourcePackIdentity,
  catalogue: readonly CommercialPack[],
): CommercialPackMappingDecision {
  if (!hasRequiredIdentity(source)) {
    return { kind: 'review', reason: 'missing_required_identity' };
  }

  const identifierCandidates = catalogue.filter((pack) =>
    pack.identityStatus === 'verified'
    && pack.verifiedIdentifiers.some((candidate) =>
      candidate.verificationStatus === 'verified'
      && source.identifiers.some((identifier) =>
        identifier.scheme === candidate.scheme && identifier.value === candidate.value,
      ),
    ),
  );

  if (identifierCandidates.length === 0) {
    return { kind: 'review', reason: 'no_verified_identifier_match' };
  }

  const exactCandidates = identifierCandidates.filter((pack) => exactIdentity(source, pack));
  if (exactCandidates.length === 1) {
    return { kind: 'approved', productId: exactCandidates[0]!.id };
  }

  const candidateProductIds = Object.freeze(
    (exactCandidates.length > 1 ? exactCandidates : identifierCandidates)
      .map((pack) => pack.id)
      .sort(),
  );
  return exactCandidates.length > 1
    ? { kind: 'review', reason: 'ambiguous_verified_match', candidateProductIds }
    : { kind: 'review', reason: 'identity_mismatch', candidateProductIds };
}

function hasRequiredIdentity(source: SourcePackIdentity): source is SourcePackIdentity & Readonly<{
  manufacturer: string;
  strength: string;
  dosageForm: string;
  packSize: PackSize;
  saleUnit: string;
}> {
  return source.identifiers.length > 0
    && nonempty(source.manufacturer)
    && nonempty(source.strength)
    && nonempty(source.dosageForm)
    && source.packSize !== undefined
    && isPositiveDecimalString(source.packSize.value)
    && nonempty(source.packSize.unit)
    && nonempty(source.saleUnit);
}

function exactIdentity(source: SourcePackIdentity & Readonly<{ packSize: PackSize }>, pack: CommercialPack): boolean {
  return (source.brand === undefined || source.brand === pack.brand)
    && source.manufacturer === pack.manufacturer
    && source.strength === pack.strength
    && source.dosageForm === pack.dosageForm
    && source.packSize.value === pack.packSize.value
    && source.packSize.unit === pack.packSize.unit
    && source.saleUnit === pack.saleUnit;
}

function nonempty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
