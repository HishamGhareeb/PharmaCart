import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticStockSink } from '../src/sink.ts';
import { NonSyntheticSinkError, openSyntheticStockSink, syntheticSinkAcknowledgement, type SyntheticSinkConfig } from '../src/synthetic-entry.ts';

// This is the only supported way to construct a sink, and it exists so a synthetic development component
// can never become a production default by omission. Every gate here is deliberately explicit: the caller
// must name a local file target, must acknowledge that the component is development-only, and must not be
// running in production. Anything that looks like a real pharmacy system is refused outright.

async function workspace(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pharmacart-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ledgerPath: join(directory, 'sink.json') };
}

function config(ledgerPath: string, overrides: Record<string, unknown> = {}): SyntheticSinkConfig {
  return {
    target: 'synthetic-file',
    acknowledgement: syntheticSinkAcknowledgement,
    ledgerPath,
    mode: 'apply',
    ...overrides,
  } as SyntheticSinkConfig;
}

function refused(value: unknown, environment: Record<string, string | undefined>, because: string) {
  assert.throws(() => openSyntheticStockSink(value, environment), (error: unknown) => {
    assert.ok(error instanceof NonSyntheticSinkError, `expected a configuration refusal for ${because}`);
    assert.equal(error.code, 'SINK_CONFIGURATION_REFUSED');
    assert.ok(error.detail.length > 0, 'a refusal must tell an operator which gate rejected the configuration');
    return true;
  }, `expected ${because} to be refused`);
}

test('a fully explicit synthetic configuration opens a usable sink', async (t) => {
  const { ledgerPath } = await workspace(t);

  const sink = openSyntheticStockSink(config(ledgerPath), { NODE_ENV: 'development' });

  assert.ok(sink instanceof SyntheticStockSink);
  assert.equal(sink.path, ledgerPath);
  assert.equal(sink.mode, 'apply');
  assert.equal(sink.guaranteesIdempotentApply, false, 'the guarantee must stay opt-in through the entry point');
  assert.equal(openSyntheticStockSink(config(ledgerPath, { idempotentApply: true }), { NODE_ENV: 'test' }).guaranteesIdempotentApply, true);
  // Opening a sink must not touch the filesystem until a call actually needs the ledger.
  await assert.rejects(access(ledgerPath));
});

test('the synthetic component refuses to run in production under any configuration', async (t) => {
  const { ledgerPath } = await workspace(t);
  // There is no override, no flag and no acknowledgement that permits this. A fake stock ledger in
  // production would silently absorb real receipts and report them as applied.
  for (const NODE_ENV of ['production', 'Production', 'PRODUCTION', 'prod', 'staging']) {
    refused(config(ledgerPath), { NODE_ENV }, `NODE_ENV=${NODE_ENV}`);
  }
  for (const environment of [{}, { NODE_ENV: undefined }, { NODE_ENV: '' }]) {
    // An unset environment is not evidence of a development machine, so it is refused as well.
    refused(config(ledgerPath), environment, `an unset NODE_ENV (${JSON.stringify(environment)})`);
  }
  for (const NODE_ENV of ['development', 'test']) {
    assert.ok(openSyntheticStockSink(config(ledgerPath), { NODE_ENV }) instanceof SyntheticStockSink);
  }
});

test('a missing or wrong acknowledgement is refused', async (t) => {
  const { ledgerPath } = await workspace(t);
  const environment = { NODE_ENV: 'development' };
  for (const acknowledgement of [undefined, '', 'yes', 'true', syntheticSinkAcknowledgement.toUpperCase(), `${syntheticSinkAcknowledgement} `, 1, true]) {
    refused(config(ledgerPath, { acknowledgement }), environment, `acknowledgement ${JSON.stringify(acknowledgement)}`);
  }
  assert.match(syntheticSinkAcknowledgement, /synthetic/, 'the acknowledgement must read as an explicit synthetic opt-in');
});

test('anything that is not a local synthetic file target is refused', async (t) => {
  const { directory, ledgerPath } = await workspace(t);
  const environment = { NODE_ENV: 'development' };
  for (const target of [undefined, '', 'file', 'http', 'pharmacy', 'postgres', 'synthetic', 'SYNTHETIC-FILE', 7]) {
    refused(config(ledgerPath, { target }), environment, `target ${JSON.stringify(target)}`);
  }
  // A path that names a host, a service or a network share is not a local synthetic ledger. Refusing
  // these by shape is what keeps an accidental edit from pointing the sink at a real pharmacy system.
  const nonLocal = [
    'postgres://pharmacart@pharmacy.internal:5432/stock',
    'https://pharmacy.example.com/api/receipts',
    'http://127.0.0.1:8080/receipts',
    'file:///C:/stock/sink.json',
    '\\\\pharmacy-nas\\stock\\sink.json',
    '//pharmacy-nas/stock/sink.json',
    'pharmacy.internal:5432',
    'user@pharmacy.internal:/stock/sink.json',
    'stock/sink.json',
    './sink.json',
    '',
  ];
  for (const path of nonLocal) refused(config(path), environment, `ledgerPath ${JSON.stringify(path)}`);
  for (const ledger of [undefined, null, 7, {}]) refused(config(ledgerPath, { ledgerPath: ledger }), environment, `ledgerPath ${JSON.stringify(ledger)}`);
  // An absolute local path inside a real directory remains acceptable.
  assert.ok(openSyntheticStockSink(config(join(directory, 'nested', 'sink.json')), environment) instanceof SyntheticStockSink);
});

test('unknown keys and out-of-range bounds are refused rather than ignored', async (t) => {
  const { ledgerPath } = await workspace(t);
  const environment = { NODE_ENV: 'development' };
  for (const value of [undefined, null, 'config', 7, [], () => undefined]) refused(value, environment, `a ${typeof value} configuration`);
  // Silently ignoring an unrecognised key is how a reviewed gate stops matching the deployed behaviour.
  refused(config(ledgerPath, { allowProduction: true }), environment, 'an unknown configuration key');
  refused(config(ledgerPath, { endpoint: 'https://pharmacy.example.com' }), environment, 'an endpoint key');
  for (const mode of ['', 'anything', 'APPLY', 7, null]) refused(config(ledgerPath, { mode }), environment, `mode ${JSON.stringify(mode)}`);
  for (const lockWaitMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001, '100']) {
    refused(config(ledgerPath, { lockWaitMs }), environment, `lockWaitMs ${JSON.stringify(lockWaitMs)}`);
  }
  for (const idempotentApply of ['true', 1, null]) {
    refused(config(ledgerPath, { idempotentApply }), environment, `idempotentApply ${JSON.stringify(idempotentApply)}`);
  }
  // The documented modes all remain reachable so a fault drill does not need a private constructor.
  for (const mode of ['apply', 'timeout_after_apply', 'unavailable'] as const) {
    assert.equal(openSyntheticStockSink(config(ledgerPath, { mode }), environment).mode, mode);
  }
});
