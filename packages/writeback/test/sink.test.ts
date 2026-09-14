import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertWritebackPayload, syntheticSinkKey, syntheticStockReceiptToken, writebackPayloadHash, type WritebackPayload } from '../src/payload.ts';
import { SyntheticStockSink, sinkLedgerLimits, type SyntheticStockSinkOptions } from '../src/sink.ts';

// The sink stands in for a pharmacy stock system that this project must never actually contact. It is a
// file-backed ledger with no database involvement, so these tests are the real evidence for the parts of
// the writeback contract that do not need PostgreSQL: one stock receipt per key however many instances or
// processes apply it, an uncertain apply that still leaves discoverable evidence, and a refusal rather
// than a guess whenever the ledger is locked, corrupt or oversized.

const run = promisify(execFile);
const module = pathToFileURL(fileURLToPath(new URL('../src/sink.ts', import.meta.url))).href;
const payloadModule = pathToFileURL(fileURLToPath(new URL('../src/payload.ts', import.meta.url))).href;

const identity = {
  brand: 'SYN Brand',
  manufacturer: 'SYN Maker',
  strength: '5 mg',
  dosageForm: 'tablet',
  packSize: { value: '20', unit: 'tablet' },
  saleUnit: 'box',
};

function payload(overrides: Record<string, unknown> = {}): WritebackPayload {
  return assertWritebackPayload({
    writebackId: 'b1000000-0000-4000-8000-000000000001',
    receiptId: 'b2000000-0000-4000-8000-000000000001',
    intentId: 'b3000000-0000-4000-8000-000000000001',
    organisationId: '10000000-0000-4000-8000-000000000001',
    branchId: '20000000-0000-4000-8000-000000000001',
    reference: 'receipt-stable',
    lines: [{
      lineId: 'b4000000-0000-4000-8000-000000000001',
      needId: '40000000-0000-4000-8000-000000000001',
      quantity: '1',
      packIdentity: identity,
    }],
    ...overrides,
  });
}

async function workspace(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-sink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A nested path also proves the ledger directory is created under contention.
  return { directory, path: join(directory, 'stock', 'sink.json') };
}

async function readLedger(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    version: number; applyCalls: number;
    receipts: Record<string, { payloadHash: string; receiptToken: string; stockReceiptId: string }>;
  };
}

function refusal(code: string) {
  return (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, code, `expected ${code}, got ${String(error)}`);
    return true;
  };
}

test('an applied writeback becomes one stock receipt whose token vouches for the payload', async (t) => {
  const { path } = await workspace(t);
  const sink = new SyntheticStockSink(path, 'apply');
  const one = payload();

  const ack = await sink.apply(one);

  assert.equal(ack.sinkKey, syntheticSinkKey(one));
  assert.equal(ack.payloadHash, writebackPayloadHash(one));
  // The token is the sink's positive evidence and is checkable by the caller without trusting the sink.
  assert.equal(ack.receiptToken, syntheticStockReceiptToken(ack.sinkKey, ack.payloadHash));
  assert.equal(ack.lineCount, 1);

  assert.deepEqual(await sink.lookup(ack.sinkKey), ack, 'a lookup must agree with the apply it follows');
  assert.equal(await sink.lookup(syntheticSinkKey(payload({ receiptId: 'b2000000-0000-4000-8000-000000000009' }))), undefined,
    'an unrelated key must not resolve to this stock receipt');
  const ledger = await readLedger(path);
  assert.equal(ledger.applyCalls, 1);
  assert.deepEqual(Object.keys(ledger.receipts), [ack.sinkKey]);
});

test('repeated and concurrent applies of one key keep exactly one stock receipt', async (t) => {
  const { path } = await workspace(t);
  const one = payload();
  // Six independent instances stand in for six competing workers that all believe they hold the claim.
  const sinks = Array.from({ length: 6 }, () => new SyntheticStockSink(path, 'apply'));

  const acks = await Promise.all(sinks.map((sink) => sink.apply(one)));

  for (const ack of acks) assert.deepEqual(ack, acks[0], 'every racing caller must observe one stock receipt');
  const ledger = await readLedger(path);
  assert.deepEqual(Object.keys(ledger.receipts), [acks[0]!.sinkKey], 'a duplicate stock receipt must be impossible');
  assert.equal(ledger.applyCalls, 6, 'no ledger write may be lost to a concurrent write');
  assert.equal(await new SyntheticStockSink(path, 'apply').apply(one).then((a) => a.stockReceiptId), acks[0]!.stockReceiptId,
    'a later apply must resolve to the original stock receipt identity');
});

test('independent processes applying one key converge on one stock receipt', async (t) => {
  const { directory, path } = await workspace(t);
  const child = join(directory, 'apply-child.mjs');
  const barrier = join(directory, 'start');
  const count = 4;
  // Each child announces readiness then waits on a shared barrier so the applies genuinely overlap.
  await writeFile(child, `import { writeFile, access } from 'node:fs/promises';
import { SyntheticStockSink } from ${JSON.stringify(module)};
import { assertWritebackPayload } from ${JSON.stringify(payloadModule)};
const [path, index, barrier, raw] = process.argv.slice(2);
await writeFile(barrier + '-ready-' + index, index);
for (let waited = 0; waited < 500; waited += 1) {
  try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
}
const sink = new SyntheticStockSink(path, 'apply', { lockWaitMs: 30000 });
process.stdout.write(JSON.stringify(await sink.apply(assertWritebackPayload(JSON.parse(raw)))));
`);

  const raw = JSON.stringify(payload());
  const children = Array.from({ length: count }, (_, index) =>
    run(process.execPath, [child, path, String(index), barrier, raw], { timeout: 60_000, windowsHide: true }));
  for (let waited = 0; waited < 500; waited += 1) {
    const ready = await Promise.all(Array.from({ length: count }, (_, index) =>
      readFile(`${barrier}-ready-${index}`, 'utf8').then(() => true, () => false)));
    if (ready.every(Boolean)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await writeFile(barrier, 'go');
  const results = (await Promise.all(children)).map(({ stdout }) => JSON.parse(stdout) as { stockReceiptId: string });

  assert.equal(new Set(results.map((result) => result.stockReceiptId)).size, 1,
    'separate processes must not each mint their own stock receipt for one key');
  const ledger = await readLedger(path);
  assert.equal(Object.keys(ledger.receipts).length, 1);
  assert.equal(ledger.applyCalls, count, 'a cross-process write must not be lost');
});

test('a process that restarts rediscovers its stock receipt from the retained ledger', async (t) => {
  const { directory, path } = await workspace(t);
  const applier = join(directory, 'restart-apply.mjs');
  const looker = join(directory, 'restart-lookup.mjs');
  const raw = JSON.stringify(payload());
  // The applying process exits completely before the looking process starts, so nothing in memory can
  // carry the answer: the retained file is the only evidence that the stock receipt already exists.
  await writeFile(applier, `import { SyntheticStockSink } from ${JSON.stringify(module)};
import { assertWritebackPayload } from ${JSON.stringify(payloadModule)};
const sink = new SyntheticStockSink(process.argv[2], 'timeout_after_apply');
try { await sink.apply(assertWritebackPayload(JSON.parse(process.argv[3]))); process.stdout.write('applied'); }
catch (error) { process.stdout.write(String(error.code)); }
`);
  await writeFile(looker, `import { SyntheticStockSink } from ${JSON.stringify(module)};
const sink = new SyntheticStockSink(process.argv[2], 'apply');
process.stdout.write(JSON.stringify(await sink.lookup(process.argv[3]) ?? null));
`);

  const first = await run(process.execPath, [applier, path, raw], { timeout: 60_000, windowsHide: true });
  assert.equal(first.stdout, 'SINK_APPLY_UNCERTAIN', 'a post-apply timeout must be reported as uncertain');

  const key = syntheticSinkKey(payload());
  const second = await run(process.execPath, [looker, path, key], { timeout: 60_000, windowsHide: true });
  const found = JSON.parse(second.stdout) as { payloadHash: string; receiptToken: string } | null;

  assert.ok(found, 'the restarted process must find the stock receipt the lost apply already recorded');
  assert.equal(found.payloadHash, writebackPayloadHash(payload()));
  assert.equal(found.receiptToken, syntheticStockReceiptToken(key, found.payloadHash));
  assert.equal((await readLedger(path)).applyCalls, 1, 'the restart must not have applied a second time');
});

test('an uncertain apply is indistinguishable at the caller but leaves honest evidence', async (t) => {
  const { path: recorded } = await workspace(t);
  const { path: lost } = await workspace(t);
  const one = payload();

  // Accepted then disconnected: the stock receipt exists although the caller was told nothing.
  const after = new SyntheticStockSink(recorded, 'timeout_after_apply');
  await assert.rejects(after.apply(one), refusal('SINK_APPLY_UNCERTAIN'));
  const found = await new SyntheticStockSink(recorded, 'apply').lookup(syntheticSinkKey(one));
  assert.equal(found?.payloadHash, writebackPayloadHash(one), 'the recorded receipt must be discoverable by lookup');

  // Unreachable before acceptance: nothing was recorded, and the caller sees the identical failure.
  const before = new SyntheticStockSink(lost, 'unavailable');
  await assert.rejects(before.apply(one), refusal('SINK_APPLY_UNCERTAIN'));
  assert.equal(await new SyntheticStockSink(lost, 'apply').lookup(syntheticSinkKey(one)), undefined);
  // Neither the refused apply nor the settling lookup may bring a ledger into existence, otherwise
  // "never reached" and "reached, holds nothing" stop being distinguishable to an operator.
  await assert.rejects(access(lost), 'an apply that never reached the sink must not have written a ledger');
});

test('a lookup is strictly read-only, so reconciliation cannot disturb the evidence', async (t) => {
  const { path } = await workspace(t);
  const sink = new SyntheticStockSink(path, 'apply');
  const ack = await sink.apply(payload());
  const before = await readFile(path, 'utf8');

  // Reconciliation runs repeatedly, including against keys that hold nothing. None of it may write.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await sink.lookup(ack.sinkKey), ack);
    assert.equal(await sink.lookup(syntheticSinkKey(payload({ receiptId: 'b2000000-0000-4000-8000-000000000007' }))), undefined);
  }

  assert.equal(await readFile(path, 'utf8'), before, 'a lookup must leave the ledger byte-identical');
  assert.equal((await readLedger(path)).applyCalls, 1, 'a lookup must not be counted as an apply');
  await assert.rejects(access(`${path}.lock`), 'a lookup must not leave a lock marker behind');
});

test('the idempotency guarantee is advertised explicitly and defaults to absent', async (t) => {
  const { path } = await workspace(t);
  // The processor decides whether a retry is safe from the advertised contract, never from the fact that
  // this particular implementation happens to deduplicate. A sink that does not promise idempotency must
  // not be treated as idempotent just because it is file-backed.
  assert.equal(new SyntheticStockSink(path, 'apply').guaranteesIdempotentApply, false);
  assert.equal(new SyntheticStockSink(path, 'apply', { idempotentApply: false }).guaranteesIdempotentApply, false);
  assert.equal(new SyntheticStockSink(path, 'apply', { idempotentApply: true }).guaranteesIdempotentApply, true);
});

test('one key with a different payload is refused and never overwrites the recorded receipt', async (t) => {
  const { path } = await workspace(t);
  const sink = new SyntheticStockSink(path, 'apply');
  const ack = await sink.apply(payload());
  const before = await readFile(path, 'utf8');

  // Same receipt, different lines: the durable record and the sink disagree and must not be merged.
  const changed = payload({ lines: [{ lineId: 'b4000000-0000-4000-8000-000000000001', needId: '40000000-0000-4000-8000-000000000001', quantity: '2', packIdentity: identity }] });
  assert.equal(syntheticSinkKey(changed), ack.sinkKey, 'this test needs one key with two payloads');
  await assert.rejects(sink.apply(changed), refusal('SINK_RECEIPT_CONFLICT'));

  assert.equal(await readFile(path, 'utf8'), before, 'a refused apply must leave the ledger byte-identical');
  assert.deepEqual(await sink.lookup(ack.sinkKey), ack, 'the original receipt must survive the conflict');
});

test('a corrupt ledger is refused and is never read as empty or repaired', async (t) => {
  const { path } = await workspace(t);
  const one = payload();
  const key = syntheticSinkKey(one);
  const hash = writebackPayloadHash(one);
  const token = syntheticStockReceiptToken(key, hash);
  const line = JSON.stringify(one.lines[0]);
  const good = `"sinkKey":"${key}","payloadHash":"${hash}","receiptToken":"${token}","stockReceiptId":"syn-stock-${key.slice(key.lastIndexOf('-') + 1)}","lineCount":1,"lines":[${line}]`;
  const corruptions = [
    'not json at all',
    '{"version":1,"applyCalls":0,',
    '[]',
    'null',
    '"a string"',
    '{"version":2,"applyCalls":0,"receipts":{}}',
    '{"applyCalls":0,"receipts":{}}',
    '{"version":1,"receipts":{}}',
    '{"version":1,"applyCalls":-1,"receipts":{}}',
    '{"version":1,"applyCalls":1.5,"receipts":{}}',
    '{"version":1,"applyCalls":0,"receipts":[]}',
    '{"version":1,"applyCalls":0,"receipts":null}',
    `{"version":1,"applyCalls":1,"receipts":{"${key}":{"payloadHash":"nope"}}}`,
    `{"version":1,"applyCalls":1,"receipts":{"${key}":null}}`,
    `{"version":1,"applyCalls":1,"receipts":{"not-a-sink-key":{${good}}}}`,
    // A token that does not derive from the recorded hash is forged positive evidence.
    `{"version":1,"applyCalls":1,"receipts":{"${key}":{${good.replace(token, syntheticStockReceiptToken(key, '0'.repeat(64)))}}}}`,
    // A key whose entry claims a different key would let one lookup answer for another receipt.
    `{"version":1,"applyCalls":1,"receipts":{"${key}":{${good.replace(`"sinkKey":"${key}"`, `"sinkKey":"${syntheticSinkKey(payload({ receiptId: 'b2000000-0000-4000-8000-000000000008' }))}"`)}}}}`,
    // A line count that disagrees with the lines would misreport what the sink holds.
    `{"version":1,"applyCalls":1,"receipts":{"${key}":{${good.replace('"lineCount":1', '"lineCount":2')}}}}`,
    `{"version":1,"applyCalls":1,"receipts":{"${key}":{${good.replace(`"lines":[${line}]`, '"lines":[]')}}}}`,
  ];
  for (const corrupt of corruptions) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, corrupt);
    const sink = new SyntheticStockSink(path, 'apply');
    // Treating an unreadable ledger as empty would apply a second stock receipt for an already applied
    // writeback, so both directions must refuse and leave the bytes for an operator to inspect.
    await assert.rejects(sink.apply(one), refusal('SINK_LEDGER_CORRUPT'), `apply must refuse ${corrupt}`);
    await assert.rejects(sink.lookup(key), refusal('SINK_LEDGER_CORRUPT'), `lookup must refuse ${corrupt}`);
    assert.equal(await readFile(path, 'utf8'), corrupt, 'a corrupt ledger must be left exactly as found');
  }
});

test('an oversized ledger is refused before it is parsed', async (t) => {
  const { path } = await workspace(t);
  await mkdir(dirname(path), { recursive: true });
  // A ledger larger than the reviewed bound is a fault, not an invitation to read it into memory.
  const padding = 'x'.repeat(sinkLedgerLimits.maxLedgerBytes + 1);
  await writeFile(path, JSON.stringify({ version: 1, applyCalls: 0, receipts: {}, padding }));
  assert.ok((await stat(path)).size > sinkLedgerLimits.maxLedgerBytes);
  const sink = new SyntheticStockSink(path, 'apply');

  await assert.rejects(sink.apply(payload()), refusal('SINK_LEDGER_TOO_LARGE'));
  await assert.rejects(sink.lookup(syntheticSinkKey(payload())), refusal('SINK_LEDGER_TOO_LARGE'));

  // A smaller configured bound must also be honoured, so an operator can tighten it.
  const tight = new SyntheticStockSink(path, 'apply', { maxLedgerBytes: 64 });
  await assert.rejects(tight.apply(payload()), refusal('SINK_LEDGER_TOO_LARGE'));
});

test('an unavailable ledger is refused within a bound and its evidence is preserved', async (t) => {
  const { path } = await workspace(t);
  const seeded = new SyntheticStockSink(path, 'apply');
  const kept = await seeded.apply(payload());
  const before = await readFile(path, 'utf8');

  // A crashed holder leaves its marker behind. Age alone must never authorise taking it over.
  const holder = `${path}.lock`;
  await writeFile(holder, JSON.stringify({ owner: 'synthetic-crashed-process' }), { flag: 'wx' });
  const blocked = new SyntheticStockSink(path, 'apply', { lockWaitMs: 150, lockPollMs: 10 });

  const started = process.hrtime.bigint();
  await assert.rejects(blocked.apply(payload({ receiptId: 'b2000000-0000-4000-8000-000000000002' })), refusal('SINK_LEDGER_LOCKED'));
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed >= 50, `the refusal must wait for the bound, waited ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `the wait must be bounded, waited ${elapsed}ms`);

  await assert.rejects(blocked.lookup(kept.sinkKey), refusal('SINK_LEDGER_LOCKED'));
  assert.equal(await readFile(path, 'utf8'), before, 'a refused write must leave the ledger byte-identical');
  assert.deepEqual(JSON.parse(await readFile(holder, 'utf8')), { owner: 'synthetic-crashed-process' },
    'the refusing instance must not delete or rewrite another holder marker');

  await rm(holder);
  assert.deepEqual(await new SyntheticStockSink(path, 'apply').lookup(kept.sinkKey), kept);
});

test('lock bounds that cannot bound a wait are refused before any ledger access', async (t) => {
  const { path } = await workspace(t);
  // A wait that is not a finite count of milliseconds cannot end, so the refusal guarantee would
  // silently become an unbounded spin.
  const unusable: SyntheticStockSinkOptions[] = [
    { lockWaitMs: Number.NaN }, { lockWaitMs: Number.POSITIVE_INFINITY }, { lockWaitMs: Number.NEGATIVE_INFINITY },
    { lockWaitMs: -1 }, { lockWaitMs: 60_001 }, { lockWaitMs: 1.5 },
    { lockPollMs: Number.NaN }, { lockPollMs: Number.POSITIVE_INFINITY }, { lockPollMs: 0 },
    { lockPollMs: -5 }, { lockPollMs: 1_001 }, { lockPollMs: 2.5 },
    { maxLedgerBytes: 0 }, { maxLedgerBytes: -1 }, { maxLedgerBytes: 1.5 },
    { maxLedgerBytes: Number.NaN }, { maxLedgerBytes: Number.POSITIVE_INFINITY },
    { maxLedgerBytes: sinkLedgerLimits.maxLedgerBytes + 1 },
  ];
  for (const options of unusable) {
    assert.throws(() => new SyntheticStockSink(path, 'apply', options), RangeError,
      `expected ${JSON.stringify(options)} to be refused at construction`);
  }
  assert.throws(() => new SyntheticStockSink(path, 'not-a-mode' as 'apply'), RangeError, 'an unknown mode must be refused');
  assert.throws(() => new SyntheticStockSink('', 'apply'), RangeError, 'an empty ledger path must be refused');
  await assert.rejects(access(dirname(path)), 'a refused configuration must not have touched the filesystem');

  for (const options of [{ lockWaitMs: 0, lockPollMs: 1 }, { lockWaitMs: 60_000, lockPollMs: 1_000 }, {}]) {
    assert.ok(new SyntheticStockSink(path, 'apply', options) instanceof SyntheticStockSink);
  }
});

test('a wall clock moving backwards cannot extend the bounded wait', async (t) => {
  const { directory, path } = await workspace(t);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.lock`, JSON.stringify({ owner: 'synthetic-other-process' }), { flag: 'wx' });
  const child = join(directory, 'clock-child.mjs');
  // The child reads a wall clock that jumps an hour into the past on every reading. A deadline derived
  // from that clock is never reached, so this process would wait forever; it is killed and reported as a
  // failure rather than hanging the suite.
  await writeFile(child, `import { SyntheticStockSink } from ${JSON.stringify(module)};
import { assertWritebackPayload } from ${JSON.stringify(payloadModule)};
let clock = Date.now();
Date.now = () => { clock -= 3_600_000; return clock; };
const sink = new SyntheticStockSink(process.argv[2], 'apply', { lockWaitMs: 150, lockPollMs: 10 });
try { await sink.apply(assertWritebackPayload(JSON.parse(process.argv[3]))); process.stdout.write('applied'); }
catch (error) { process.stdout.write(String(error.code)); }
`);

  const finished = await run(process.execPath, [child, path, JSON.stringify(payload())], { timeout: 15_000, windowsHide: true })
    .catch((error: Error) => assert.fail(`the bounded refusal never arrived: ${error.message}`));

  assert.equal(finished.stdout, 'SINK_LEDGER_LOCKED', 'the wait must be measured on a monotonic clock');
  await assert.rejects(access(path), 'a refused acquisition must not have written the ledger');
});

test('the sink refuses a malformed payload or key instead of recording it', async (t) => {
  const { path } = await workspace(t);
  const sink = new SyntheticStockSink(path, 'apply');
  // The sink revalidates rather than trusting its caller, so a payload that bypassed the repository
  // cannot become a stock receipt that no durable row can ever be matched against.
  for (const value of [undefined, null, {}, 'payload', { ...payload(), lines: [] }]) {
    await assert.rejects(sink.apply(value as WritebackPayload), refusal('WRITEBACK_PAYLOAD_INVALID'),
      `apply must refuse ${JSON.stringify(value)}`);
  }
  for (const key of ['', 'not-a-key', 'pc-syn-wb-', 'pc-syn-wb-NOTHEX', `pc-syn-wb-${'0'.repeat(200)}`]) {
    await assert.rejects(sink.lookup(key), refusal('WRITEBACK_PAYLOAD_INVALID'), `lookup must refuse ${JSON.stringify(key)}`);
  }
  await assert.rejects(access(path), 'a refused call must not have created a ledger');
});
