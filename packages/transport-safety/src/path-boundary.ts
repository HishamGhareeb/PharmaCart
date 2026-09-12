import fs from 'node:fs/promises';
import path from 'node:path';

export type PathRejectionReason =
  | 'empty_path'
  | 'path_too_long'
  | 'control_character'
  | 'unc_path'
  | 'absolute_path'
  | 'drive_qualified_path'
  | 'empty_segment'
  | 'segment_too_long'
  | 'relative_segment'
  | 'stream_separator'
  | 'trailing_dot_or_space'
  | 'reserved_device_name'
  | 'escapes_root';

export type PathBoundaryDecision =
  | Readonly<{ kind: 'accepted'; absolutePath: string; relativePath: string }>
  | Readonly<{ kind: 'rejected'; reason: PathRejectionReason; segment: string }>;

export type ContainedFileReadRequest = Readonly<{
  root: string;
  relativePath: string;
  maxBytes: number;
}>;

export type ContainedFileReadDecision =
  | Readonly<{ kind: 'accepted'; absolutePath: string; data: Uint8Array }>
  | Readonly<{
      kind: 'rejected';
      reason: PathRejectionReason | 'input_too_large' | 'invalid_byte_limit' | 'read_failed';
      detail: string;
    }>;

export interface ContainedFileReader {
  readContained(request: ContainedFileReadRequest): Promise<ContainedFileReadDecision>;
}

export const containedFilesystemReader: ContainedFileReader = {
  readContained: ({ root, relativePath, maxBytes }) =>
    readContainedFileWithinRoot(root, relativePath, maxBytes),
};

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const SEPARATOR = /[/\\]/;
const BACKSLASH = '\\';

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function resolveContainedPath(root: string, untrustedPath: string): PathBoundaryDecision {
  const rejection = inspectUntrustedSegments(untrustedPath);
  if (rejection !== undefined) {
    return rejection;
  }

  const resolvedRoot = path.resolve(root);
  const relativePath = untrustedPath.split(SEPARATOR).join('/');
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!isPathWithinRoot(resolvedRoot, absolutePath)) {
    return reject('escapes_root', untrustedPath);
  }

  return { kind: 'accepted', absolutePath, relativePath };
}

export async function resolveContainedRealPath(
  root: string,
  untrustedPath: string,
): Promise<PathBoundaryDecision> {
  const decision = resolveContainedPath(root, untrustedPath);
  if (decision.kind === 'rejected') {
    return decision;
  }

  const realRoot = await nearestRealPath(path.resolve(root));
  const realCandidate = await nearestRealPath(decision.absolutePath);
  if (realRoot === undefined || realCandidate === undefined) {
    return reject('escapes_root', untrustedPath);
  }
  if (!isPathWithinRoot(realRoot, realCandidate)) {
    return reject('escapes_root', untrustedPath);
  }

  return decision;
}

export async function readContainedFileWithinRoot(
  root: string,
  untrustedPath: string,
  maxBytes: number,
): Promise<ContainedFileReadDecision> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { kind: 'rejected', reason: 'invalid_byte_limit', detail: untrustedPath };
  }

  const located = resolveContainedPath(root, untrustedPath);
  if (located.kind === 'rejected') {
    return { kind: 'rejected', reason: located.reason, detail: located.segment };
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([
      fs.realpath(path.resolve(root)),
      fs.realpath(located.absolutePath),
    ]);
  } catch {
    return { kind: 'rejected', reason: 'read_failed', detail: untrustedPath };
  }
  if (!isPathWithinRoot(realRoot, realCandidate)) {
    return { kind: 'rejected', reason: 'escapes_root', detail: untrustedPath };
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(realCandidate, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      return { kind: 'rejected', reason: 'read_failed', detail: untrustedPath };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        return { kind: 'rejected', reason: 'input_too_large', detail: untrustedPath };
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return {
      kind: 'accepted',
      absolutePath: realCandidate,
      data: new Uint8Array(Buffer.concat(chunks, total)),
    };
  } catch {
    return { kind: 'rejected', reason: 'read_failed', detail: untrustedPath };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = comparable(path.resolve(root));
  const resolvedCandidate = comparable(path.resolve(candidate));
  const boundary = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate !== resolvedRoot && resolvedCandidate.startsWith(boundary);
}

function inspectUntrustedSegments(untrustedPath: string): PathBoundaryDecision | undefined {
  if (untrustedPath.length === 0) {
    return reject('empty_path', '');
  }
  if (untrustedPath.length > MAX_PATH_LENGTH) {
    return reject('path_too_long', '');
  }
  for (const character of untrustedPath) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return reject('control_character', '');
    }
  }
  if (untrustedPath.length >= 2 && isSeparator(untrustedPath[0]) && isSeparator(untrustedPath[1])) {
    return reject('unc_path', '');
  }
  if (isSeparator(untrustedPath[0])) {
    return reject('absolute_path', '');
  }
  if (/^[A-Za-z]:/.test(untrustedPath)) {
    return reject('drive_qualified_path', '');
  }

  for (const segment of untrustedPath.split(SEPARATOR)) {
    const segmentRejection = inspectSegment(segment);
    if (segmentRejection !== undefined) {
      return segmentRejection;
    }
  }

  return undefined;
}

function inspectSegment(segment: string): PathBoundaryDecision | undefined {
  if (segment.length === 0) {
    return reject('empty_segment', segment);
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return reject('segment_too_long', segment);
  }
  if (segment === '.' || segment === '..') {
    return reject('relative_segment', segment);
  }
  if (segment.includes(':')) {
    return reject('stream_separator', segment);
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return reject('trailing_dot_or_space', segment);
  }
  if (RESERVED_DEVICE_NAMES.has(deviceName(segment))) {
    return reject('reserved_device_name', segment);
  }
  return undefined;
}

async function nearestRealPath(target: string): Promise<string | undefined> {
  let current = target;
  for (;;) {
    try {
      const resolved = await fs.realpath(current);
      return current === target ? resolved : path.join(resolved, path.relative(current, target));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

function deviceName(segment: string): string {
  const head = segment.split('.')[0] ?? '';
  return head.trimEnd().toLowerCase();
}

function isSeparator(character: string | undefined): boolean {
  return character === '/' || character === BACKSLASH;
}

function comparable(value: string): string {
  return path.sep === BACKSLASH ? value.toLowerCase() : value;
}

function reject(reason: PathRejectionReason, segment: string): PathBoundaryDecision {
  return { kind: 'rejected', reason, segment };
}
