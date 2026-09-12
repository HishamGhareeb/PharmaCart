import {
  addDecimals,
  compareDecimals,
  subtractDecimals,
} from '../../exact-decimal/src/exact-decimal.ts';

export type StockPosition = Readonly<{
  sourceCode: string;
  onHand: string;
  unit: string;
  stale: boolean;
}>;

export type CoverageTarget = Readonly<{
  sourceCode: string;
  targetQuantity: string;
  unit: string;
}>;

export type OpenCommitment = Readonly<{
  commitmentId: string;
  sourceCode: string;
  quantity: string;
  unit: string;
}>;

export type DerivedNeed = Readonly<{
  sourceCode: string;
  unit: string;
  onHand: string;
  onOrder: string;
  target: string;
  shortfall: string;
}>;

export type WithholdingReason =
  | 'no_observation'
  | 'stale_observation'
  | 'unit_mismatch'
  | 'negative_quantity'
  | 'unreadable_amount'
  | 'covered';

export type NeedInputRejectionReason =
  | 'duplicate_target'
  | 'duplicate_position'
  | 'duplicate_commitment';

export type WithheldPosition = Readonly<{
  sourceCode: string;
  reason: WithholdingReason;
}>;

export type NeedDerivation =
  | Readonly<{
      kind: 'derived';
      needs: readonly DerivedNeed[];
      withheld: readonly WithheldPosition[];
    }>
  | Readonly<{ kind: 'rejected'; reason: NeedInputRejectionReason; sourceCode: string }>;

/**
 * Two absences are deliberately not treated as zero. A product with no
 * observation at all is unknown, not empty, because the feed may simply not
 * have carried it; reading that as zero stock orders a full target of something
 * the shelf may already hold. A stale observation is likewise withheld, since
 * ordering against stock known to be out of date is how a pharmacy over-buys.
 *
 * Ambiguity in the input is rejected outright rather than resolved. A source
 * code appearing twice among positions has no single on-hand quantity, and
 * silently keeping whichever arrived last would make the answer depend on the
 * order rows came back from a query.
 *
 * What counts as an open commitment is deliberately not decided here. An order
 * submitted but unacknowledged, one acknowledged but undelivered, and one whose
 * outcome is unknown are three different states, and the choice of which to
 * include changes whether this over-orders or double-orders. The caller passes
 * the commitments it means, and owns that decision explicitly.
 */
export function deriveNeeds(
  targets: readonly CoverageTarget[],
  positions: readonly StockPosition[],
  commitments: readonly OpenCommitment[],
): NeedDerivation {
  const duplicateTarget = firstDuplicate(targets.map((entry) => entry.sourceCode));
  if (duplicateTarget !== undefined) {
    return { kind: 'rejected', reason: 'duplicate_target', sourceCode: duplicateTarget };
  }

  const duplicatePosition = firstDuplicate(positions.map((entry) => entry.sourceCode));
  if (duplicatePosition !== undefined) {
    return { kind: 'rejected', reason: 'duplicate_position', sourceCode: duplicatePosition };
  }

  const duplicateCommitment = firstDuplicate(commitments.map((entry) => entry.commitmentId));
  if (duplicateCommitment !== undefined) {
    const owner = commitments.find((entry) => entry.commitmentId === duplicateCommitment);
    return { kind: 'rejected', reason: 'duplicate_commitment', sourceCode: owner?.sourceCode ?? '' };
  }

  const positionBySourceCode = new Map(positions.map((entry) => [entry.sourceCode, entry]));
  const needs: DerivedNeed[] = [];
  const withheld: WithheldPosition[] = [];

  for (const target of [...targets].sort(bySourceCode)) {
    const assessed = assessTarget(
      target,
      positionBySourceCode.get(target.sourceCode),
      commitments.filter((entry) => entry.sourceCode === target.sourceCode),
    );
    if (typeof assessed === 'string') {
      withheld.push({ sourceCode: target.sourceCode, reason: assessed });
      continue;
    }
    needs.push(assessed);
  }

  return Object.freeze({
    kind: 'derived',
    needs: Object.freeze(needs),
    withheld: Object.freeze(withheld),
  });
}

function assessTarget(
  target: CoverageTarget,
  position: StockPosition | undefined,
  commitments: readonly OpenCommitment[],
): DerivedNeed | WithholdingReason {
  if (position === undefined) {
    return 'no_observation';
  }
  if (position.stale) {
    return 'stale_observation';
  }
  if (position.unit !== target.unit) {
    return 'unit_mismatch';
  }
  if (commitments.some((entry) => entry.unit !== target.unit)) {
    return 'unit_mismatch';
  }

  for (const quantity of [target.targetQuantity, position.onHand, ...commitments.map((entry) => entry.quantity)]) {
    const sign = compareDecimals(quantity, '0');
    if (sign === undefined) {
      return 'unreadable_amount';
    }
    if (sign < 0) {
      return 'negative_quantity';
    }
  }

  let onOrder = '0';
  for (const commitment of commitments) {
    const total = addDecimals(onOrder, commitment.quantity);
    if (total === undefined) {
      return 'unreadable_amount';
    }
    onOrder = total;
  }

  const held = addDecimals(position.onHand, onOrder);
  if (held === undefined) {
    return 'unreadable_amount';
  }
  const shortfall = subtractDecimals(target.targetQuantity, held);
  if (shortfall === undefined) {
    return 'unreadable_amount';
  }

  const covered = compareDecimals(shortfall, '0');
  if (covered === undefined) {
    return 'unreadable_amount';
  }
  if (covered <= 0) {
    return 'covered';
  }

  return Object.freeze({
    sourceCode: target.sourceCode,
    unit: target.unit,
    onHand: position.onHand,
    onOrder,
    target: target.targetQuantity,
    shortfall,
  });
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.push(value);
      continue;
    }
    seen.add(value);
  }
  return duplicates.sort()[0];
}

function bySourceCode(left: CoverageTarget, right: CoverageTarget): number {
  if (left.sourceCode === right.sourceCode) {
    return 0;
  }
  return left.sourceCode < right.sourceCode ? -1 : 1;
}
