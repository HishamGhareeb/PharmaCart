import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { FakeSupplier, type FakeSupplierOptions } from '../src/fake.ts';

// Independent FakeSupplier instances, including instances in separate processes, share one synthetic
// ledger file. These tests describe the observable ledger contract rather than the locking mechanism:
// one stable external order per reference, no lost writes, no corrupt JSON, and a refusal instead of
// a guess when exclusive access cannot be obtained.

const run = promisify(execFile);
const line = (suffix: string) => [{ lineId: `aaaaaaaa-0000-4000-8000-00000000${suffix}`, quantity: '2' }];
const module = pathToFileURL(fileURLToPath(new URL('../src/fake.ts', import.meta.url))).href;

async function workspace(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-fake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A nested path also proves the ledger directory is created under contention.
  return { directory, path: join(directory, 'ledger', 'ledger.json') };
}

async function readLedger(path: string) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as { submitCalls: number; lookupCalls: number; orders: Record<string, { externalOrderId: string }> };
}

test('independent instances submitting one reference converge on a single external order', async (t) => {
  const { path } = await workspace(t);
  const reference = 'pc-syn-CONCURRENT01';
  const suppliers = Array.from({ length: 6 }, () => new FakeSupplier(path, 'accepted'));

  const acknowledgements = await Promise.all(suppliers.map((supplier) => supplier.submit(reference, line('01'))));

  const externalOrderIds = new Set(acknowledgements.map((acknowledgement) => acknowledgement.externalOrderId));
  assert.equal(externalOrderIds.size, 1, 'every racing caller must observe the same external order identity');
  for (const acknowledgement of acknowledgements) assert.deepEqual(acknowledgement, acknowledgements[0]);

  const ledger = await readLedger(path);
  assert.deepEqual(Object.keys(ledger.orders), [reference], 'the ledger must retain exactly one synthetic order');
  assert.equal(ledger.submitCalls, 6, 'no ledger write may be lost to a concurrent write');
  assert.equal(ledger.orders[reference]!.externalOrderId, acknowledgements[0]!.externalOrderId);

  const observer = new FakeSupplier(path, 'accepted');
  assert.deepEqual(await observer.lookup(reference), acknowledgements[0], 'a later lookup must agree with the submissions');
  assert.equal((await observer.ledger()).lookupCalls, 1);
});

test('concurrent submissions of distinct references all survive in one ledger', async (t) => {
  const { path } = await workspace(t);
  const references = Array.from({ length: 8 }, (_, index) => `pc-syn-PARALLEL${index}`);

  const acknowledgements = await Promise.all(references.map((reference, index) =>
    new FakeSupplier(path, 'accepted').submit(reference, line(`1${index}`))));

  const ledger = await readLedger(path);
  assert.deepEqual(Object.keys(ledger.orders).sort(), [...references].sort(), 'no submission may be dropped');
  assert.equal(ledger.submitCalls, references.length);
  assert.equal(ledger.lookupCalls, 0);
  assert.equal(new Set(acknowledgements.map((a) => a.externalOrderId)).size, references.length,
    'distinct references must keep distinct external orders');
});

test('independent processes submitting one reference converge on a single external order', async (t) => {
  const { directory, path } = await workspace(t);
  const reference = 'pc-syn-MULTIPROC01';
  const child = join(directory, 'submit-child.mjs');
  const barrier = join(directory, 'start');
  const count = 4;
  // Each child announces readiness, then waits for the shared barrier so the submissions genuinely overlap.
  await writeFile(child, `import { writeFile, access } from 'node:fs/promises';
import { FakeSupplier } from ${JSON.stringify(module)};
const [path, reference, index, barrier] = process.argv.slice(2);
await writeFile(barrier + '-ready-' + index, index);
for (let waited = 0; waited < 500; waited += 1) {
  try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
}
const supplier = new FakeSupplier(path, 'accepted');
const acknowledgement = await supplier.submit(reference, [{ lineId: 'aaaaaaaa-0000-4000-8000-000000000099', quantity: '2' }]);
process.stdout.write(JSON.stringify(acknowledgement));
`);

  const children = Array.from({ length: count }, (_, index) =>
    run(process.execPath, [child, path, reference, String(index), barrier], { timeout: 60_000, windowsHide: true }));
  for (let waited = 0; waited < 500; waited += 1) {
    const ready = await Promise.all(Array.from({ length: count }, (_, index) =>
      readFile(`${barrier}-ready-${index}`, 'utf8').then(() => true, () => false)));
    if (ready.every(Boolean)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await writeFile(barrier, 'go');
  const results = (await Promise.all(children)).map(({ stdout }) => JSON.parse(stdout) as { externalOrderId: string });

  assert.equal(new Set(results.map((result) => result.externalOrderId)).size, 1,
    'separate processes must not each mint their own external order for one reference');
  const ledger = await readLedger(path);
  assert.deepEqual(Object.keys(ledger.orders), [reference]);
  assert.equal(ledger.submitCalls, count, 'a cross-process write must not be lost');
  assert.equal(ledger.orders[reference]!.externalOrderId, results[0]!.externalOrderId);
});

test('a submission in flight does not block a competing lookup, which sees no order yet', async (t) => {
  const { path } = await workspace(t);
  const reference = 'pc-syn-INFLIGHT01';
  let released!: () => void;
  const held = new Promise<void>((resolve) => { released = resolve; });
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  // A send that has left the caller but has not yet reached the supplier must not hold the ledger.
  class Delayed extends FakeSupplier {
    async submit(order: string, lines: { lineId: string; quantity: string }[]) {
      reached();
      await held;
      return super.submit(order, lines);
    }
  }
  const sender = new Delayed(path, 'accepted');
  const observer = new FakeSupplier(path, 'accepted', { lockWaitMs: 1000, lockPollMs: 10 });

  const sending = sender.submit(reference, line('04'));
  await entered;
  assert.equal(await observer.lookup(reference), undefined, 'an unfinished send is not yet a supplier order');

  released();
  const acknowledgement = await sending;
  assert.deepEqual(await observer.lookup(reference), acknowledgement, 'the finished send becomes visible to every instance');
  const ledger = await readLedger(path);
  assert.equal(ledger.submitCalls, 1);
  assert.equal(ledger.lookupCalls, 2);
});

test('an unavailable ledger is refused within a bound, and evidence is never overwritten or broken', async (t) => {
  const { path } = await workspace(t);
  const seeded = new FakeSupplier(path, 'accepted');
  const kept = await seeded.submit('pc-syn-SEED000001', line('02'));
  const before = await readFile(path, 'utf8');

  // A crashed holder leaves its marker behind. Age alone must never authorise taking it over.
  const holder = `${path}.lock`;
  await writeFile(holder, JSON.stringify({ owner: 'synthetic-crashed-process' }), { flag: 'wx' });
  const blocked = new FakeSupplier(path, 'accepted', { lockWaitMs: 150, lockPollMs: 10 });

  const started = process.hrtime.bigint();
  await assert.rejects(blocked.submit('pc-syn-BLOCKED0001', line('03')), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'SUPPLIER_LEDGER_LOCKED', 'exclusive access must be refused, not assumed');
    return true;
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed >= 50, `the refusal must wait for the bound, waited ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `the wait must be bounded, waited ${elapsed}ms`);

  await assert.rejects(blocked.lookup('pc-syn-SEED000001'), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'SUPPLIER_LEDGER_LOCKED', 'an unreadable ledger must not answer "not found"');
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), before, 'a refused write must leave the ledger byte-identical');
  assert.deepEqual(JSON.parse(await readFile(holder, 'utf8')), { owner: 'synthetic-crashed-process' },
    'the refusing instance must not delete or rewrite another holder marker');

  // Once the holder is cleared by an operator, normal service resumes with the evidence intact.
  await rm(holder);
  assert.deepEqual(await new FakeSupplier(path, 'accepted').lookup('pc-syn-SEED000001'), kept);
});

test('lock bounds that cannot bound a wait are refused before any ledger access', async (t) => {
  const { path } = await workspace(t);
  // A wait that is not a finite count of milliseconds cannot end: a NaN or infinite deadline is never
  // reached, so the refusal guarantee would silently become an unbounded spin.
  const unusable: FakeSupplierOptions[] = [
    { lockWaitMs: Number.NaN }, { lockWaitMs: Number.POSITIVE_INFINITY }, { lockWaitMs: Number.NEGATIVE_INFINITY },
    { lockWaitMs: -1 }, { lockWaitMs: 60_001 }, { lockWaitMs: 1.5 },
    { lockPollMs: Number.NaN }, { lockPollMs: Number.POSITIVE_INFINITY }, { lockPollMs: 0 },
    { lockPollMs: -5 }, { lockPollMs: 1_001 }, { lockPollMs: 2.5 },
  ];
  for (const options of unusable) {
    assert.throws(() => new FakeSupplier(path, 'accepted', options), RangeError,
      `expected ${JSON.stringify(options)} to be refused at construction`);
  }
  await assert.rejects(access(dirname(path)), 'a refused configuration must not have touched the filesystem');

  // The usable extremes stay usable, including an immediate-refusal wait.
  for (const options of [{ lockWaitMs: 0, lockPollMs: 1 }, { lockWaitMs: 60_000, lockPollMs: 1_000 }, {}]) {
    assert.ok(new FakeSupplier(path, 'accepted', options) instanceof FakeSupplier);
  }
  const immediate = new FakeSupplier(path, 'accepted', { lockWaitMs: 0, lockPollMs: 1 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.lock`, JSON.stringify({ owner: 'synthetic-other-process' }), { flag: 'wx' });
  await assert.rejects(immediate.submit('pc-syn-IMMEDIATE1', line('05')), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'SUPPLIER_LEDGER_LOCKED');
    return true;
  });
});

test('a wall clock moving backwards cannot extend the bounded wait', async (t) => {
  const { directory, path } = await workspace(t);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.lock`, JSON.stringify({ owner: 'synthetic-other-process' }), { flag: 'wx' });
  const child = join(directory, 'clock-child.mjs');
  // The child reads a wall clock that jumps an hour into the past on every reading. A deadline derived
  // from that clock is never reached, so this process would wait forever; it is killed and reported as a
  // failure rather than hanging the suite.
  await writeFile(child, `import { FakeSupplier } from ${JSON.stringify(module)};
const [path] = process.argv.slice(2);
let clock = Date.now();
Date.now = () => { clock -= 3_600_000; return clock; };
const supplier = new FakeSupplier(path, 'accepted', { lockWaitMs: 150, lockPollMs: 10 });
try {
  await supplier.submit('pc-syn-CLOCKJUMP1', [{ lineId: 'aaaaaaaa-0000-4000-8000-000000000006', quantity: '2' }]);
  process.stdout.write('submitted');
} catch (error) {
  process.stdout.write(String(error.code));
}
`);

  const finished = await run(process.execPath, [child, path], { timeout: 15_000, windowsHide: true })
    .catch((error: Error) => assert.fail(`the bounded refusal never arrived: ${error.message}`));

  assert.equal(finished.stdout, 'SUPPLIER_LEDGER_LOCKED', 'the wait must be measured on a monotonic clock');
  await assert.rejects(access(path), 'a refused acquisition must not have written the ledger');
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, 'utf8')), { owner: 'synthetic-other-process' });
});
