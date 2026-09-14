import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  DeliverySinkLockError,
  DeliverySinkRefusedError,
  SyntheticFileDeliverySink,
  type SyntheticSinkOptions,
} from '../src/sink.ts';
import { sealDeliveryPayload } from '../src/payload.ts';

// The sink is the only component that knows a notification left the system. It keeps that fact in a
// file, independently of the database, so an accepted-then-timed-out delivery can be resolved by
// lookup instead of by sending a second push. These tests describe that observable contract.

const run = promisify(execFile);
const module = pathToFileURL(fileURLToPath(new URL('../src/sink.ts', import.meta.url))).href;
const sealModule = pathToFileURL(fileURLToPath(new URL('../src/payload.ts', import.meta.url))).href;

const deliveryId = '80000000-0000-4000-8000-000000000001';
const otherDeliveryId = '80000000-0000-4000-8000-000000000002';
const payload = sealDeliveryPayload({
  episodeId: '70000000-0000-4000-8000-000000000001',
  installationId: '50000000-0000-4000-8000-000000000001',
  title: 'Stock needs attention',
  body: 'Open PharmaCart to review this alert.',
});

const clock = () => '2026-09-12T12:00:00.000Z';

async function workspace(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-sink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A nested path also proves the ledger directory is created under contention.
  return { directory, path: join(directory, 'deliveries', 'sink.json') };
}

function sink(path: string, overrides: Partial<SyntheticSinkOptions> = {}) {
  return new SyntheticFileDeliverySink({ path, clock, lockWaitMs: 2000, lockPollMs: 5, ...overrides });
}

async function refusal(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof DeliverySinkRefusedError, `expected a refusal, received ${String(error)}`);
    assert.equal(error.code, 'SINK_REFUSED');
    return error.violation;
  }
  assert.fail('expected the sink to refuse');
}

test('an accepted delivery is recorded once and is retrievable by identifier', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path);
  const receipt = await adapter.deliver(deliveryId, payload);
  assert.equal(receipt.deliveryId, deliveryId);
  assert.equal(receipt.acceptedAt, '2026-09-12T12:00:00.000Z');
  assert.match(receipt.receiptId, /^syn-[0-9a-f-]{36}$/);
  assert.deepEqual(await adapter.lookup(deliveryId), receipt);
  const ledger = await adapter.ledger();
  assert.equal(Object.keys(ledger.receipts).length, 1);
  assert.equal(ledger.deliverCalls, 1);
});

test('repeating a delivery returns the first receipt and adds no second notification', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path);
  const first = await adapter.deliver(deliveryId, payload);
  const second = await adapter.deliver(deliveryId, payload);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.acceptedAt, first.acceptedAt);
  const ledger = await adapter.ledger();
  assert.equal(ledger.deliverCalls, 2, 'both calls are visible as attempts');
  assert.equal(Object.keys(ledger.receipts).length, 1, 'only one notification exists');
});

test('a timeout after acceptance still leaves the delivery findable by lookup', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path, { mode: 'timeout_after_accept' });
  await assert.rejects(adapter.deliver(deliveryId, payload), /connection lost after acceptance/);
  const found = await adapter.lookup(deliveryId);
  assert.ok(found, 'the accepted delivery must be visible to a later lookup');
  // A caller that resolved the unknown outcome by lookup and then retried anyway must still not
  // produce a second notification.
  const retried = sink(path).deliver(deliveryId, payload);
  await assert.doesNotReject(retried);
  assert.equal((await retried).receiptId, found.receiptId);
  assert.equal(Object.keys((await adapter.ledger()).receipts).length, 1);
});

test('an unavailable sink records nothing and lookup reports nothing', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path, { mode: 'unavailable' });
  await assert.rejects(adapter.deliver(deliveryId, payload), /unavailable/);
  assert.equal(await adapter.lookup(deliveryId), undefined);
  assert.equal(Object.keys((await adapter.ledger()).receipts).length, 0);
});

test('lookup of an unknown identifier creates nothing', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path);
  assert.equal(await adapter.lookup(otherDeliveryId), undefined);
  const ledger = await adapter.ledger();
  assert.equal(Object.keys(ledger.receipts).length, 0);
  assert.equal(ledger.lookupCalls, 1);
});

test('concurrent deliveries of one identifier produce one notification', async (t) => {
  const { path } = await workspace(t);
  const adapters = Array.from({ length: 6 }, () => sink(path));
  const receipts = await Promise.all(adapters.map((adapter) => adapter.deliver(deliveryId, payload)));
  assert.equal(new Set(receipts.map((receipt) => receipt.receiptId)).size, 1);
  const ledger = await adapters[0]!.ledger();
  assert.equal(ledger.deliverCalls, 6);
  assert.equal(Object.keys(ledger.receipts).length, 1);
});

// Regression, finding S1. On Windows an exclusive create that races the previous holder's unlink of the
// marker can fail with EPERM instead of EEXIST. The lane rethrew anything but EEXIST, so a busy ledger
// surfaced as a sink failure: a send became outcome_unknown and then manual review, and the alert was
// never delivered. Contention on that code is now waited out within the same bound.
test('heavy contention on one ledger is waited out rather than failing a delivery', async (t) => {
  const { path } = await workspace(t);
  const identifiers = Array.from({ length: 12 }, (_, index) => `80000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`);
  for (let round = 0; round < 8; round += 1) {
    const adapters = identifiers.map(() => sink(path, { lockWaitMs: 10_000, lockPollMs: 1 }));
    await Promise.all(adapters.map((adapter, index) => (index % 2 === 0
      ? adapter.deliver(identifiers[index]!, payload)
      : adapter.lookup(identifiers[index]!))));
  }
  const ledger = await sink(path).ledger();
  assert.equal(ledger.deliverCalls, 48);
  assert.equal(ledger.lookupCalls, 48);
  assert.equal(Object.keys(ledger.receipts).length, 6);
});

test('independent processes sharing the ledger produce one notification', async (t) => {
  const { directory, path } = await workspace(t);
  const script = join(directory, 'deliver.ts');
  await writeFile(script, `
    import { SyntheticFileDeliverySink } from ${JSON.stringify(module)};
    import { sealDeliveryPayload } from ${JSON.stringify(sealModule)};
    const sink = new SyntheticFileDeliverySink({
      path: ${JSON.stringify(path)}, clock: () => '2026-09-12T12:00:00.000Z', lockWaitMs: 5000, lockPollMs: 5,
    });
    const payload = sealDeliveryPayload(${JSON.stringify(payload)});
    const receipt = await sink.deliver(${JSON.stringify(deliveryId)}, payload);
    process.stdout.write(receipt.receiptId);
  `);
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    run(process.execPath, ['--experimental-strip-types', script], { cwd: dirname(script) })));
  assert.equal(new Set(results.map((result) => result.stdout.trim())).size, 1);
  const ledger = JSON.parse(await readFile(path, 'utf8')) as { receipts: Record<string, unknown>; deliverCalls: number };
  assert.equal(Object.keys(ledger.receipts).length, 1);
  assert.equal(ledger.deliverCalls, 4);
});

test('exclusive access is abandoned within its bound instead of waiting forever', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path, { lockWaitMs: 60, lockPollMs: 5 });
  await adapter.deliver(otherDeliveryId, payload);
  await writeFile(`${path}.lock`, JSON.stringify({ owner: 'someone-else', pid: 1 }));
  const started = process.hrtime.bigint();
  await assert.rejects(adapter.deliver(deliveryId, payload), (error: unknown) => {
    assert.ok(error instanceof DeliverySinkLockError);
    assert.equal(error.code, 'SINK_LEDGER_LOCKED');
    return true;
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs >= 50, `refusal after ${elapsedMs}ms must respect the bound`);
  assert.ok(elapsedMs < 5000, `refusal after ${elapsedMs}ms must not hang`);
  // The foreign marker is evidence of a crashed holder and is never taken over on age alone.
  assert.equal(JSON.parse(await readFile(`${path}.lock`, 'utf8')).owner, 'someone-else');
});

test('unusable acquisition bounds are refused before any file is touched', async (t) => {
  const { path } = await workspace(t);
  for (const options of [
    { lockWaitMs: -1 }, { lockWaitMs: 1.5 }, { lockWaitMs: Number.NaN }, { lockWaitMs: Number.POSITIVE_INFINITY },
    { lockWaitMs: 600_000 }, { lockPollMs: 0 }, { lockPollMs: 100_000 },
    { maxReceipts: 0 }, { maxReceipts: 10_000_000 }, { maxPayloadBytes: 0 },
  ]) {
    assert.throws(() => sink(path, options), RangeError, JSON.stringify(options));
  }
  assert.throws(() => sink(''), TypeError);
  assert.throws(() => new SyntheticFileDeliverySink({ path, clock: undefined as unknown as () => string }), TypeError);
});

test('a delivery identifier that is not opaque is refused', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path);
  assert.equal(await refusal(() => adapter.deliver('delivery-1', payload)), 'identifier_not_opaque');
  assert.equal(await refusal(() => adapter.deliver('', payload)), 'identifier_not_opaque');
  assert.equal(await refusal(() => adapter.lookup('../../etc/passwd')), 'identifier_not_opaque');
  assert.equal(Object.keys((await adapter.ledger()).receipts).length, 0);
});

test('a payload that is oversized or carries extra fields is refused at the boundary', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path);
  const widened = { ...payload, productName: 'Amoxicillin 500mg' } as unknown as typeof payload;
  assert.equal(await refusal(() => adapter.deliver(deliveryId, widened)), 'payload_shape');
  const long = { ...payload, body: 'x'.repeat(500) } as unknown as typeof payload;
  assert.equal(await refusal(() => adapter.deliver(deliveryId, long)), 'payload_shape');
  const tiny = sink(path, { maxPayloadBytes: 16 });
  assert.equal(await refusal(() => tiny.deliver(deliveryId, payload)), 'payload_too_large');
  assert.equal(Object.keys((await adapter.ledger()).receipts).length, 0);
});

test('the ledger refuses to grow past its bound instead of filling the disk', async (t) => {
  const { path } = await workspace(t);
  const adapter = sink(path, { maxReceipts: 2 });
  await adapter.deliver(deliveryId, payload);
  await adapter.deliver(otherDeliveryId, payload);
  const third = '80000000-0000-4000-8000-000000000003';
  assert.equal(await refusal(() => adapter.deliver(third, payload)), 'ledger_capacity_exceeded');
  // An identifier already recorded still resolves, so capacity never forces a duplicate send.
  assert.ok(await adapter.lookup(deliveryId));
  assert.equal(Object.keys((await adapter.ledger()).receipts).length, 2);
});

test('an unusable injected clock is refused rather than stamped with server time', async (t) => {
  const { path } = await workspace(t);
  assert.equal(await refusal(() => sink(path, { clock: () => 'not-a-date' }).deliver(deliveryId, payload)), 'invalid_clock');
  assert.equal(
    await refusal(() => sink(path, { clock: (() => 42) as unknown as () => string }).deliver(deliveryId, payload)),
    'invalid_clock',
  );
  assert.equal(Object.keys((await sink(path).ledger()).receipts).length, 0);
});

test('the synthetic sink identifies itself as synthetic', async (t) => {
  const { path } = await workspace(t);
  assert.equal(sink(path).kind, 'synthetic');
});
