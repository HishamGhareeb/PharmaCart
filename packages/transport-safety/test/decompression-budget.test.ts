import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import { gunzipWithinBudget } from '../src/decompression-budget.ts';

function gzipped(byteLength: number): Uint8Array {
  return new Uint8Array(zlib.gzipSync(Buffer.alloc(byteLength, 0x41)));
}

function rejectionReason(
  source: Uint8Array,
  limits?: Parameters<typeof gunzipWithinBudget>[1],
): string {
  const decision = limits === undefined
    ? gunzipWithinBudget(source)
    : gunzipWithinBudget(source, limits);
  assert.equal(decision.kind, 'rejected');
  return decision.kind === 'rejected' ? decision.reason : '';
}

describe('bounded gzip decompression', () => {
  it('restores a small feed payload and reports its expansion ratio', () => {
    const payload = new TextEncoder().encode('sku,quantity\nSKU-1,12\n');
    const decision = gunzipWithinBudget(new Uint8Array(zlib.gzipSync(payload)));

    assert.equal(decision.kind, 'accepted');
    assert.deepEqual(decision.kind === 'accepted' ? decision.data : new Uint8Array(), payload);
    assert.ok((decision.kind === 'accepted' ? decision.ratio : 0) > 0);
  });

  it('rejects compressed input larger than the transport budget', () => {
    assert.equal(rejectionReason(gzipped(4096), { maxInputBytes: 8 }), 'input_too_large');
  });

  it('rejects a decompression bomb on the output cap before allocating it', () => {
    assert.equal(
      rejectionReason(gzipped(4 * 1024 * 1024), { maxOutputBytes: 64 * 1024 }),
      'output_too_large',
    );
  });

  it('rejects an expansion ratio beyond policy even when output fits', () => {
    assert.equal(
      rejectionReason(gzipped(1024 * 1024), { maxOutputBytes: 8 * 1024 * 1024, maxRatio: 10 }),
      'ratio_exceeded',
    );
  });

  it('rejects input that is not a gzip member at all', () => {
    assert.equal(rejectionReason(new TextEncoder().encode('sku,quantity')), 'invalid_archive');
    assert.equal(rejectionReason(new Uint8Array(0)), 'invalid_archive');
  });
});
