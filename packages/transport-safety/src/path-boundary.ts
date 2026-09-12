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
