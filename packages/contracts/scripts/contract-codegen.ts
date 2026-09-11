import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_FILES = [
  'approval-command.schema.json',
  'decimal.schema.json',
  'order-lookup.schema.json',
  'submit-result.schema.json',
] as const;

export type JsonSchema = Record<string, unknown>;
export type SchemaEntry = Readonly<{ name: string; schema: JsonSchema }>;

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const contractsDirectory = join(scriptsDirectory, '..');

const SUPPORTED_KEYWORDS = new Set([
  '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'const', 'deprecated',
  'description', 'format', 'maxLength', 'maximum', 'minLength', 'minimum', 'oneOf',
  'pattern', 'properties', 'required', 'title', 'type',
]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSupportedSchema(schema: JsonSchema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword ${keyword} at ${path}`);
    }
  }
  const properties = schema.properties;
  if (properties !== undefined) {
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error(`properties must be an object at ${path}`);
    }
    for (const [name, child] of Object.entries(properties)) {
      assertSupportedSchema(child as JsonSchema, `${path}.properties.${name}`);
    }
  }
  const definitions = schema.$defs;
  if (definitions !== undefined) {
    if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
      throw new Error(`$defs must be an object at ${path}`);
    }
    for (const [name, child] of Object.entries(definitions)) {
      assertSupportedSchema(child as JsonSchema, `${path}.$defs.${name}`);
    }
  }
  const alternatives = schema.oneOf;
  if (alternatives !== undefined) {
    if (!Array.isArray(alternatives)) {
      throw new Error(`oneOf must be an array at ${path}`);
    }
    alternatives.forEach((child, index) => assertSupportedSchema(child as JsonSchema, `${path}.oneOf[${index}]`));
  }
}

function resolveLocalRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith('#/')) {
    throw new Error(`unsupported non-local $ref ${ref}`);
  }
  let current: unknown = root;
  for (const encodedSegment of ref.slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`unresolved $ref ${ref}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema;
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderSchemaType(schema: JsonSchema, root: JsonSchema, refs: readonly string[] = []): string {
  if (typeof schema.$ref === 'string') {
    if (refs.includes(schema.$ref)) throw new Error(`unsupported recursive $ref ${schema.$ref}`);
    return renderSchemaType(resolveLocalRef(schema.$ref, root), root, [...refs, schema.$ref]);
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((member) => renderSchemaType(member as JsonSchema, root, refs)).join('\n  | ');
  }
  if (Object.hasOwn(schema, 'const')) {
    return JSON.stringify(schema.const);
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) throw new Error('unsupported open object schema');
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    const fields = Object.entries(properties ?? {}).map(([name, child]) =>
      `readonly ${propertyName(name)}${required.has(name) ? '' : '?'}: ${renderSchemaType(child, root, refs)};`);
    return `Readonly<{ ${fields.join(' ')} }>`;
  }
  throw new Error('schema cannot be rendered to TypeScript');
}

export function readCanonicalSchemaEntries(): SchemaEntry[] {
  return SCHEMA_FILES.map((name) => ({
    name,
    schema: JSON.parse(readFileSync(join(contractsDirectory, 'schema', name), 'utf8')) as JsonSchema,
  }));
}

export function readCanonicalSchemas(): ReadonlyArray<unknown> {
  return readCanonicalSchemaEntries().map(({ schema }) => schema);
}

function sourceHash(entries: readonly SchemaEntry[]): string {
  const canonicalSource = [...entries]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map(({ name, schema }) => `${name}\n${stableJson(schema)}`)
    .join('\n');
  return createHash('sha256').update(canonicalSource, 'utf8').digest('hex');
}

export function renderGeneratedContractsFromEntries(entries: readonly SchemaEntry[]): string {
  for (const { name, schema } of entries) assertSupportedSchema(schema, name);
  const byName = new Map(entries.map((entry) => [entry.name, entry.schema]));
  const requiredSchema = (name: string): JsonSchema => {
    const schema = byName.get(name);
    if (schema === undefined) throw new Error(`missing canonical schema ${name}`);
    return schema;
  };
  const approval = requiredSchema('approval-command.schema.json');
  const submit = requiredSchema('submit-result.schema.json');
  const lookup = requiredSchema('order-lookup.schema.json');

  return `// Generated by scripts/generate-contracts.ts. Do not edit.\n// source-sha256: ${sourceHash(entries)}\n\n`
    + `// Decimal brands are explicit wrappers around the validated decimal schema.\n`
    + `export type CanonicalDecimalString = string & { readonly __canonicalDecimal: unique symbol };\n`
    + `export type NonNegativeDecimalString = CanonicalDecimalString & { readonly __nonNegativeDecimal: unique symbol };\n`
    + `export type PositiveDecimalString = NonNegativeDecimalString & { readonly __positiveDecimal: unique symbol };\n\n`
    + `export type ApprovalCommand = ${renderSchemaType(approval, approval)};\n\n`
    + `export type SubmitResult =\n  | ${renderSchemaType(submit, submit)};\n\n`
    + `export type OrderLookup =\n  | ${renderSchemaType(lookup, lookup)};\n`;
}

export function renderGeneratedContracts(): string {
  return renderGeneratedContractsFromEntries(readCanonicalSchemaEntries());
}
