import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyInventorySnapshotEvent, emptyInventorySnapshotState } from '../../domain/src/inventory-snapshot.ts';
import {
  adaptInventoryObservations,
  type InventoryAdapterContract,
  type InventoryEnvelope,
  type RawObservation,
} from '../src/inventory-adapter.ts';

const contract: InventoryAdapterContract = {
  adapterId: 'synthetic-pos',
  revision: 1,
  sourceCodeNormalization: 'trim',
  unitAliases: { box: 'box', boxes: 'box', bx: 'box', strip: 'strip', tab: 'tablet', tablet: 'tablet' },
};

const envelope: InventoryEnvelope = {
  eventId: 'evt-0001',
  installationId: 'inst-branch-01',
  snapshotId: 'snap-2026-09-12',
  sequence: 7,
  partitionId: 'part-a',
};

function accepted(observations: readonly RawObservation[], override: Partial<InventoryAdapterContract> = {}) {
  const decision = adaptInventoryObservations({ ...contract, ...override }, envelope, observations);
  assert.equal(decision.kind, 'accepted', decision.kind === 'rejected' ? decision.reason : '');
  return decision.kind === 'accepted' ? decision.event : undefined;
}

function rejectionReason(
  observations: readonly RawObservation[],
  override: Partial<InventoryAdapterContract> = {},
): string {
  const decision = adaptInventoryObservations({ ...contract, ...override }, envelope, observations);
  assert.equal(decision.kind, 'rejected');
  return decision.kind === 'rejected' ? decision.reason : '';
}

describe('inventory observation adaptation', () => {
  it('produces a partition event the inventory domain accepts', () => {
    const event = accepted([{ sourceCode: 'SKU-1', quantity: '12.500', unit: 'Boxes' }]);
    assert.notEqual(event, undefined);

    const result = applyInventorySnapshotEvent(emptyInventorySnapshotState(), event!);
    assert.equal(result.kind, 'accepted');
  });

  it('canonicalises quantities and resolves unit aliases case-insensitively', () => {
    const event = accepted([
      { sourceCode: 'SKU-1', quantity: '12.500', unit: 'Boxes' },
      { sourceCode: 'SKU-2', quantity: '007', unit: ' BX ' },
      { sourceCode: 'SKU-3', quantity: '0.0', unit: 'TAB' },
    ]);

    assert.deepEqual(event?.kind === 'partition' ? event.rows : [], [
      { sourceCode: 'SKU-1', quantity: '12.5', unit: 'box' },
      { sourceCode: 'SKU-2', quantity: '7', unit: 'box' },
      { sourceCode: 'SKU-3', quantity: '0', unit: 'tablet' },
    ]);
  });

  it('sorts rows by source code so transport row order cannot change the event', () => {
    const forward = accepted([
      { sourceCode: 'SKU-1', quantity: '1', unit: 'box' },
      { sourceCode: 'SKU-2', quantity: '2', unit: 'box' },
    ]);
    const reversed = accepted([
      { sourceCode: 'SKU-2', quantity: '2', unit: 'box' },
      { sourceCode: 'SKU-1', quantity: '1', unit: 'box' },
    ]);

    assert.deepEqual(forward, reversed);
  });

  it('never converts a quantity between units', () => {
    const event = accepted([{ sourceCode: 'SKU-1', quantity: '3', unit: 'box' }]);
    const row = event?.kind === 'partition' ? event.rows[0] : undefined;

    assert.equal(row?.quantity, '3');
    assert.equal(row?.unit, 'box');
  });

  it('applies the declared source-code normalisation and nothing else', () => {
    const exact = accepted([{ sourceCode: ' sku-1 ', quantity: '1', unit: 'box' }], {
      sourceCodeNormalization: 'exact',
    });
    assert.equal(exact?.kind === 'partition' ? exact.rows[0]?.sourceCode : '', ' sku-1 ');

    const trimmed = accepted([{ sourceCode: ' sku-1 ', quantity: '1', unit: 'box' }]);
    assert.equal(trimmed?.kind === 'partition' ? trimmed.rows[0]?.sourceCode : '', 'sku-1');

    const upper = accepted([{ sourceCode: ' sku-1 ', quantity: '1', unit: 'box' }], {
      sourceCodeNormalization: 'trim_upper',
    });
    assert.equal(upper?.kind === 'partition' ? upper.rows[0]?.sourceCode : '', 'SKU-1');

    const padded = accepted([{ sourceCode: '007', quantity: '1', unit: 'box' }]);
    assert.equal(padded?.kind === 'partition' ? padded.rows[0]?.sourceCode : '', '007');
  });

  it('refuses a unit the contract does not declare rather than guessing one', () => {
    assert.equal(rejectionReason([{ sourceCode: 'SKU-1', quantity: '1', unit: 'carton' }]), 'unknown_unit');
    assert.equal(rejectionReason([{ sourceCode: 'SKU-1', quantity: '1', unit: '' }]), 'unknown_unit');
  });

  it('refuses quantities that are not exact decimals', () => {
    assert.equal(rejectionReason([{ sourceCode: 'SKU-1', quantity: '1,000', unit: 'box' }]), 'invalid_quantity');
    assert.equal(rejectionReason([{ sourceCode: 'SKU-1', quantity: '1e3', unit: 'box' }]), 'invalid_quantity');
    assert.equal(rejectionReason([{ sourceCode: 'SKU-1', quantity: '-2', unit: 'box' }]), 'invalid_quantity');
  });

  it('refuses source codes that collide only after normalisation', () => {
    assert.equal(
      rejectionReason(
        [
          { sourceCode: 'sku-1', quantity: '1', unit: 'box' },
          { sourceCode: 'SKU-1', quantity: '2', unit: 'box' },
        ],
        { sourceCodeNormalization: 'trim_upper' },
      ),
      'duplicate_source_code',
    );
  });

  it('refuses an empty source code and an empty observation set', () => {
    assert.equal(rejectionReason([{ sourceCode: '  ', quantity: '1', unit: 'box' }]), 'empty_source_code');
    assert.equal(rejectionReason([]), 'empty_observation_set');
  });

  it('refuses a source code that cannot be one identity on screen and in data', () => {
    assert.equal(
      rejectionReason([{ sourceCode: 'SKU\u202e-1', quantity: '1', unit: 'box' }]),
      'unsafe_identifier',
    );
    assert.equal(
      rejectionReason([{ sourceCode: 'SKU-٠٠١', quantity: '1', unit: 'box' }]),
      'unsafe_identifier',
    );
  });

  it('refuses a field carrying a spreadsheet formula payload', () => {
    assert.equal(
      rejectionReason([{ sourceCode: '=cmd|\' /c calc\'!A0', quantity: '1', unit: 'box' }]),
      'unsafe_field',
    );
    assert.equal(
      rejectionReason([{ sourceCode: 'SKU-1', quantity: '1', unit: '@SUM(A1)' }]),
      'unsafe_field',
    );
  });
});
