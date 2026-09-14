import { createHash } from 'node:crypto';
import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';

/** The identity of one purchasable pack, copied verbatim from the immutable order snapshot. Writeback
 * never derives or converts these fields: a stock system that receives an inferred pack would record a
 * quantity against the wrong unit, and no later comparison could detect it. */
export type WritebackPackIdentity = Readonly<{
  brand: string;
  manufacturer: string;
  strength: string;
  dosageForm: string;
  packSize: Readonly<{ value: string; unit: string }>;
  saleUnit: string;
}>;

/** One confirmed receipt line. `quantity` is the exact decimal the receiver confirmed, unchanged. */
export type WritebackLine = Readonly<{
  lineId: string;
  needId: string;
  quantity: string;
  packIdentity: WritebackPackIdentity;
}>;

/** Everything the synthetic sink is ever told about one receipt. There is deliberately no supplier,
 * price, budget or inventory field: the sink records stock arrival, nothing else. */
export type WritebackPayload = Readonly<{
  writebackId: string;
  receiptId: string;
  intentId: string;
  organisationId: string;
  branchId: string;
  reference: string;
  lines: readonly WritebackLine[];
}>;

/** Bounds are part of the reviewed contract, not defensive decoration. `maxIntegerDigits` mirrors the
 * `ordered < 1000000000000` check on order_line, so a quantity that could never match a durable row is
 * refused at the boundary rather than inside the database or the sink. */
export const writebackLimits = {
  reference: { maxLength: 128 },
  lines: { max: 500 },
  quantity: { maxLength: 32, maxIntegerDigits: 12, maxFractionDigits: 6 },
  text: { maxLength: 256 },
  payloadBytes: { max: 65_536 },
} as const;

export const syntheticSinkKeyPrefix = 'pc-syn-wb-';
export const syntheticStockReceiptPrefix = 'pc-syn-stock-';
const sinkKeyPattern = /^pc-syn-wb-[0-9a-f]{32}$/;
const hashPattern = /^[0-9a-f]{64}$/;
/** Lowercase canonical UUID. Case is significant here: PostgreSQL renders uuid lowercase, so accepting a
 * mixed-case spelling would let two spellings of one identity hash differently. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Printable single-line text only. A control character in a reference reaches operator logs and files. */
const printablePattern = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+$/u;

const identityTextFields = ['brand', 'manufacturer', 'strength', 'dosageForm', 'saleUnit'] as const;
const identityFields = [...identityTextFields, 'packSize'] as const;
const lineFields = ['lineId', 'needId', 'quantity', 'packIdentity'] as const;
const payloadFields = ['writebackId', 'receiptId', 'intentId', 'organisationId', 'branchId', 'reference', 'lines'] as const;

/** Raised for any payload, key or hash that cannot be trusted as evidence. It is deliberately one code:
 * the caller's only correct response is to refuse the writeback and surface it, never to repair it. */
export class WritebackPayloadError extends Error {
  readonly code = 'WRITEBACK_PAYLOAD_INVALID';
  readonly detail: string;

  constructor(detail: string) {
    super(`Refusing a receipt writeback payload: ${detail}`);
    this.name = 'WritebackPayloadError';
    this.detail = detail;
  }
}

function refuse(detail: string): never {
  throw new WritebackPayloadError(detail);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(`${label} carries an unknown field ${JSON.stringify(key)}`);
  }
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') refuse(`${label} must be a string`);
  if (value.length === 0) refuse(`${label} must not be empty`);
  if (value.length > maxLength) refuse(`${label} must be at most ${maxLength} characters, received ${value.length}`);
  if (!printablePattern.test(value)) refuse(`${label} must not contain control or unassigned characters`);
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string') refuse(`${label} must be a string`);
  if (!uuidPattern.test(value)) refuse(`${label} must be a lowercase canonical UUID`);
  return value;
}

/** An exact decimal quantity inside the durable numeric range. The check is entirely on the string: no
 * `Number` conversion happens anywhere, because a float cannot represent these values exactly and a
 * silent rounding here would be a quantity the receiver never confirmed. */
function quantity(value: unknown, label: string): string {
  const { maxLength, maxIntegerDigits, maxFractionDigits } = writebackLimits.quantity;
  if (typeof value !== 'string') refuse(`${label} must be a decimal string, not a ${typeof value}`);
  if (value.length > maxLength) refuse(`${label} must be at most ${maxLength} characters, received ${value.length}`);
  // Canonical form rejects '1.0', '.5', '1.', '1e3', ' 1', '0' and every negative value.
  if (!isPositiveDecimalString(value, { maxLength })) refuse(`${label} must be an exact positive canonical decimal, received ${JSON.stringify(value)}`);
  const [whole = '', fraction = ''] = value.split('.');
  if (whole.length > maxIntegerDigits) refuse(`${label} must stay below 1e${maxIntegerDigits}, received ${value}`);
  if (fraction.length > maxFractionDigits) refuse(`${label} must have at most ${maxFractionDigits} fraction digits, received ${value}`);
  return value;
}

function packIdentity(value: unknown, label: string): WritebackPackIdentity {
  const source = plainObject(value, label);
  onlyKeys(source, identityFields, label);
  for (const field of identityFields) {
    if (!Object.hasOwn(source, field)) refuse(`${label} is missing ${field}; it must be copied from the order snapshot, never inferred`);
  }
  const size = plainObject(source.packSize, `${label}.packSize`);
  onlyKeys(size, ['value', 'unit'], `${label}.packSize`);
  return {
    brand: text(source.brand, `${label}.brand`, writebackLimits.text.maxLength),
    manufacturer: text(source.manufacturer, `${label}.manufacturer`, writebackLimits.text.maxLength),
    strength: text(source.strength, `${label}.strength`, writebackLimits.text.maxLength),
    dosageForm: text(source.dosageForm, `${label}.dosageForm`, writebackLimits.text.maxLength),
    packSize: {
      value: quantity(size.value, `${label}.packSize.value`),
      unit: text(size.unit, `${label}.packSize.unit`, writebackLimits.text.maxLength),
    },
    saleUnit: text(source.saleUnit, `${label}.saleUnit`, writebackLimits.text.maxLength),
  };
}

/** Validates an untrusted value and returns it in a fixed shape. Both the repository and the sink call
 * this: the sink revalidates rather than trusting its caller, so a payload that bypassed the repository
 * cannot become a stock receipt no durable row can be matched against. */
export function assertWritebackPayload(value: unknown): WritebackPayload {
  const source = plainObject(value, 'payload');
  onlyKeys(source, payloadFields, 'payload');
  if (!Array.isArray(source.lines)) refuse('payload.lines must be an array');
  if (source.lines.length === 0) refuse('payload.lines must contain at least one receipt line');
  if (source.lines.length > writebackLimits.lines.max) {
    refuse(`payload.lines must contain at most ${writebackLimits.lines.max} lines, received ${source.lines.length}`);
  }
  const lines = source.lines.map((entry, index) => {
    const label = `payload.lines[${index}]`;
    const line = plainObject(entry, label);
    onlyKeys(line, lineFields, label);
    return {
      lineId: uuid(line.lineId, `${label}.lineId`),
      needId: uuid(line.needId, `${label}.needId`),
      quantity: quantity(line.quantity, `${label}.quantity`),
      packIdentity: packIdentity(line.packIdentity, `${label}.packIdentity`),
    } satisfies WritebackLine;
  });
  // One order line may appear once. A repeated identity would double a quantity in the sink while the
  // durable receipt recorded it once.
  const identities = new Set(lines.map((line) => line.lineId));
  if (identities.size !== lines.length) refuse('payload.lines must not repeat an order line identity');

  const payload: WritebackPayload = {
    writebackId: uuid(source.writebackId, 'payload.writebackId'),
    receiptId: uuid(source.receiptId, 'payload.receiptId'),
    intentId: uuid(source.intentId, 'payload.intentId'),
    organisationId: uuid(source.organisationId, 'payload.organisationId'),
    branchId: uuid(source.branchId, 'payload.branchId'),
    reference: text(source.reference, 'payload.reference', writebackLimits.reference.maxLength),
    lines,
  };
  // A last bound on the serialised form, so no combination of individually legal fields can produce a
  // ledger entry larger than the sink was reviewed to hold.
  const bytes = Buffer.byteLength(canonicalJson(payload), 'utf8');
  if (bytes > writebackLimits.payloadBytes.max) {
    refuse(`payload must serialise to at most ${writebackLimits.payloadBytes.max} bytes, received ${bytes}`);
  }
  return payload;
}

/** Deterministic serialisation with recursively sorted keys. A jsonb column returns object keys in
 * storage order rather than insertion order, so a hash over `JSON.stringify` would change after a dump
 * and restore and make an unchanged payload look tampered with. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('a non-finite number cannot be serialised canonically');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  refuse(`a ${typeof value} cannot be serialised canonically`);
}

/** The stable identity of one stock receipt in the sink.
 *
 * Derived from the tenant and the receipt only. It deliberately excludes the receipt_writeback row id,
 * the attempt count and every timestamp, so a restored database that re-derives its queue row resolves
 * to the same stock receipt instead of creating a second one. */
export function syntheticSinkKey(payload: Pick<WritebackPayload, 'organisationId' | 'branchId' | 'receiptId'>): string {
  const digest = createHash('sha256')
    .update(`pharmacart:synthetic-writeback:v1:${uuid(payload.organisationId, 'payload.organisationId')}:${uuid(payload.branchId, 'payload.branchId')}:${uuid(payload.receiptId, 'payload.receiptId')}`)
    .digest('hex');
  return `${syntheticSinkKeyPrefix}${digest.slice(0, 32)}`;
}

/** The hash of everything that must not change between claiming a writeback and proving it applied. A
 * difference means the durable receipt and the recorded attempt disagree, which is an operator decision. */
export function writebackPayloadHash(payload: WritebackPayload): string {
  const lines = [...payload.lines].sort((left, right) => (left.lineId < right.lineId ? -1 : left.lineId > right.lineId ? 1 : 0));
  return createHash('sha256')
    .update(`pharmacart:synthetic-writeback-payload:v1:${canonicalJson({ ...payload, writebackId: undefined, lines })}`)
    .digest('hex');
}

/** The sink's positive evidence that this exact payload was recorded under this exact key.
 *
 * It is derived rather than random so a caller can recompute and check it without trusting the sink, and
 * so a restart produces the same token for the same stock receipt. It proves only that the sink recorded
 * the receipt; see docs/testing/synthetic-writeback.md for why that is not inventory inclusion. */
export function syntheticStockReceiptToken(sinkKey: string, payloadHash: string): string {
  if (typeof sinkKey !== 'string' || !sinkKeyPattern.test(sinkKey)) refuse(`sinkKey must match ${String(sinkKeyPattern)}`);
  if (typeof payloadHash !== 'string' || !hashPattern.test(payloadHash)) refuse('payloadHash must be a lowercase sha256 hex digest');
  const digest = createHash('sha256').update(`pharmacart:synthetic-stock-receipt:v1:${sinkKey}:${payloadHash}`).digest('hex');
  return `${syntheticStockReceiptPrefix}${digest.slice(0, 32)}`;
}

export function isSyntheticSinkKey(value: unknown): value is string {
  return typeof value === 'string' && sinkKeyPattern.test(value);
}

/** Refuses a key that was not produced by {@link syntheticSinkKey}, so a lookup cannot be aimed at an
 * arbitrary ledger entry. */
export function assertSyntheticSinkKey(value: unknown): string {
  if (!isSyntheticSinkKey(value)) refuse(`sinkKey must match ${String(sinkKeyPattern)}`);
  return value;
}
