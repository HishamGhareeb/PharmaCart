import { isAbsolute } from 'node:path';
import { SyntheticStockSink, sinkLedgerLimits, syntheticStockSinkModes, type SyntheticStockSinkMode } from './sink.ts';

/** The only supported way to construct a {@link SyntheticStockSink}.
 *
 * This gate exists because the sink is a development-only stand-in for a pharmacy stock system. A
 * synthetic component that can be reached by default is a component that will eventually absorb real
 * receipts and report them as applied, so every condition here is opt-in and explicit rather than
 * inferred: the caller must name a local file target, must acknowledge in writing that the component is
 * development-only, and must not be running in production. Nothing in this module can be overridden by a
 * flag or an environment variable. */

export const syntheticSinkAcknowledgement = 'i-understand-this-is-a-synthetic-development-only-stock-sink';

/** Environments in which a fake stock ledger is a legitimate thing to run. The list is an allowlist, so
 * an unset or unrecognised environment is refused rather than assumed to be a developer's machine. */
export const syntheticSinkEnvironments: readonly string[] = ['development', 'test'];

export type SyntheticSinkConfig = Readonly<{
  target: 'synthetic-file';
  acknowledgement: typeof syntheticSinkAcknowledgement;
  /** An absolute local filesystem path. Anything naming a host, scheme, share or user is refused. */
  ledgerPath: string;
  mode?: SyntheticStockSinkMode;
  lockWaitMs?: number;
  lockPollMs?: number;
  idempotentApply?: boolean;
  maxLedgerBytes?: number;
}>;

const configFields = ['target', 'acknowledgement', 'ledgerPath', 'mode', 'lockWaitMs', 'lockPollMs', 'idempotentApply', 'maxLedgerBytes'] as const;

/** Raised when a configuration is not provably a local synthetic one. It is never a warning: there is no
 * degraded mode in which the sink runs anyway. */
export class NonSyntheticSinkError extends Error {
  readonly code = 'SINK_CONFIGURATION_REFUSED';
  readonly detail: string;

  constructor(detail: string) {
    super(`Refusing to open the synthetic stock sink: ${detail}`);
    this.name = 'NonSyntheticSinkError';
    this.detail = detail;
  }
}

function refuse(detail: string): never {
  throw new NonSyntheticSinkError(detail);
}

/** Shapes that indicate a remote or otherwise non-local target. These are refused by shape rather than
 * by reachability: the point is that an accidental edit pointing at a real pharmacy system is rejected
 * before anything is opened, not that a connection attempt fails. */
function assertLocalLedgerPath(value: unknown): string {
  if (typeof value !== 'string') refuse(`ledgerPath must be a string, received ${typeof value}`);
  if (value.trim() === '') refuse('ledgerPath must not be empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) refuse(`ledgerPath must not be a URL, received ${JSON.stringify(value)}`);
  if (value.startsWith('\\\\') || value.startsWith('//')) refuse(`ledgerPath must not be a network share, received ${JSON.stringify(value)}`);
  if (value.includes('@')) refuse(`ledgerPath must not name a user or host, received ${JSON.stringify(value)}`);
  // A bare `host:port` or `host:/path` is rejected, while a Windows drive letter such as `C:\` is not.
  if (/(?:^|[^A-Za-z])[A-Za-z0-9.-]{2,}:/.test(value)) refuse(`ledgerPath must not name a host or service, received ${JSON.stringify(value)}`);
  // A relative path resolves against whatever the working directory happens to be at start-up, which is
  // not a reviewable location for a ledger that must be found again after a restart.
  if (!isAbsolute(value)) refuse(`ledgerPath must be an absolute local path, received ${JSON.stringify(value)}`);
  return value;
}

function assertOptionalInteger(source: Record<string, unknown>, field: 'lockWaitMs' | 'lockPollMs' | 'maxLedgerBytes'): number | undefined {
  if (!Object.hasOwn(source, field) || source[field] === undefined) return undefined;
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) refuse(`${field} must be a whole number, received ${JSON.stringify(value)}`);
  const bound = field === 'maxLedgerBytes'
    ? { min: 1, max: sinkLedgerLimits.maxLedgerBytes }
    : { min: sinkLedgerLimits[field].min, max: sinkLedgerLimits[field].max };
  if (value < bound.min || value > bound.max) refuse(`${field} must be between ${bound.min} and ${bound.max}, received ${value}`);
  return value;
}

/** Validates an untrusted configuration and opens the sink. No filesystem access happens here: the
 * ledger is created lazily by the first call that needs it, so a refused configuration leaves no trace
 * and an accepted one can still be discarded unused. */
export function openSyntheticStockSink(
  config: unknown,
  environment: Record<string, string | undefined> = process.env,
): SyntheticStockSink {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    refuse(`a configuration object is required, received ${Array.isArray(config) ? 'an array' : typeof config}`);
  }
  const source = config as Record<string, unknown>;
  // An unrecognised key is refused rather than ignored, because silently dropping one is how a reviewed
  // gate stops matching deployed behaviour.
  for (const key of Object.keys(source)) {
    if (!configFields.includes(key as (typeof configFields)[number])) refuse(`unknown configuration field ${JSON.stringify(key)}`);
  }
  if (source.target !== 'synthetic-file') {
    refuse(`target must be the literal "synthetic-file", received ${JSON.stringify(source.target)}`);
  }
  if (source.acknowledgement !== syntheticSinkAcknowledgement) {
    refuse(`acknowledgement must be exactly ${JSON.stringify(syntheticSinkAcknowledgement)}, received ${JSON.stringify(source.acknowledgement)}`);
  }
  // Checked after the explicit fields so an operator sees the acknowledgement requirement even on a
  // machine that would have been refused anyway, but before anything is constructed.
  const nodeEnv = environment.NODE_ENV;
  if (typeof nodeEnv !== 'string' || !syntheticSinkEnvironments.includes(nodeEnv)) {
    refuse(`NODE_ENV must be one of ${syntheticSinkEnvironments.join(', ')} to run a synthetic stock sink, received ${JSON.stringify(nodeEnv)}`);
  }
  const ledgerPath = assertLocalLedgerPath(source.ledgerPath);
  const mode = source.mode === undefined ? 'apply' : source.mode;
  if (!syntheticStockSinkModes.includes(mode as SyntheticStockSinkMode)) {
    refuse(`mode must be one of ${syntheticStockSinkModes.join(', ')}, received ${JSON.stringify(source.mode)}`);
  }
  if (Object.hasOwn(source, 'idempotentApply') && source.idempotentApply !== undefined && typeof source.idempotentApply !== 'boolean') {
    refuse(`idempotentApply must be a boolean, received ${JSON.stringify(source.idempotentApply)}`);
  }
  const lockWaitMs = assertOptionalInteger(source, 'lockWaitMs');
  const lockPollMs = assertOptionalInteger(source, 'lockPollMs');
  const maxLedgerBytes = assertOptionalInteger(source, 'maxLedgerBytes');

  return new SyntheticStockSink(ledgerPath, mode as SyntheticStockSinkMode, {
    ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
    ...(lockPollMs === undefined ? {} : { lockPollMs }),
    ...(maxLedgerBytes === undefined ? {} : { maxLedgerBytes }),
    ...(source.idempotentApply === undefined ? {} : { idempotentApply: source.idempotentApply as boolean }),
  });
}
