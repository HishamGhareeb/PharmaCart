export type BidiRejectionReason =
  | 'directional_override'
  | 'directional_isolate'
  | 'directional_mark'
  | 'text_too_long';

export type IdentifierRejectionReason =
  | BidiRejectionReason
  | 'empty_identifier'
  | 'identifier_too_long'
  | 'non_ascii_digit'
  | 'invisible_character'
  | 'control_character';

export type BidiInspection =
  | Readonly<{
      kind: 'accepted';
      hasLeftToRight: boolean;
      hasRightToLeft: boolean;
      mixed: boolean;
    }>
  | Readonly<{ kind: 'rejected'; reason: BidiRejectionReason; position: number }>;

export type IdentifierInspection =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'rejected'; reason: IdentifierRejectionReason; position: number }>;

export const LEFT_TO_RIGHT_ISOLATE = '\u2066';
export const POP_DIRECTIONAL_ISOLATE = '\u2069';

const MAX_TEXT_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 256;

const DIRECTIONAL_OVERRIDES = /[\u202a-\u202e]/u;
const DIRECTIONAL_ISOLATES = /[\u2066-\u2069]/u;
const DIRECTIONAL_MARKS = /[\u200e\u200f\u061c]/u;
const INVISIBLE_CHARACTERS = /[\u200b-\u200d\u2060\ufeff]/u;
const DECIMAL_DIGIT = /\p{Decimal_Number}/u;
const STRONG_LEFT_TO_RIGHT = /[A-Za-zÀ-ɏ]/u;
const STRONG_RIGHT_TO_LEFT = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const ALL_DIRECTIONAL_FORMATTING = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu;

export function inspectBidirectionalText(value: string): BidiInspection {
  if (value.length > MAX_TEXT_LENGTH) {
    return { kind: 'rejected', reason: 'text_too_long', position: MAX_TEXT_LENGTH };
  }

  const override = value.search(DIRECTIONAL_OVERRIDES);
  if (override !== -1) {
    return { kind: 'rejected', reason: 'directional_override', position: override };
  }

  const isolate = value.search(DIRECTIONAL_ISOLATES);
  if (isolate !== -1) {
    return { kind: 'rejected', reason: 'directional_isolate', position: isolate };
  }

  const mark = value.search(DIRECTIONAL_MARKS);
  if (mark !== -1) {
    return { kind: 'rejected', reason: 'directional_mark', position: mark };
  }

  const hasLeftToRight = STRONG_LEFT_TO_RIGHT.test(value);
  const hasRightToLeft = STRONG_RIGHT_TO_LEFT.test(value);
  return {
    kind: 'accepted',
    hasLeftToRight,
    hasRightToLeft,
    mixed: hasLeftToRight && hasRightToLeft,
  };
}

export function inspectIdentifierText(value: string): IdentifierInspection {
  if (value.trim().length === 0) {
    return { kind: 'rejected', reason: 'empty_identifier', position: 0 };
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    return { kind: 'rejected', reason: 'identifier_too_long', position: MAX_IDENTIFIER_LENGTH };
  }

  const directional = inspectBidirectionalText(value);
  if (directional.kind === 'rejected') {
    return { kind: 'rejected', reason: directional.reason, position: directional.position };
  }

  const invisible = value.search(INVISIBLE_CHARACTERS);
  if (invisible !== -1) {
    return { kind: 'rejected', reason: 'invisible_character', position: invisible };
  }

  for (let index = 0; index < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    if (DECIMAL_DIGIT.test(character) && !/[0-9]/.test(character)) {
      return { kind: 'rejected', reason: 'non_ascii_digit', position: index };
    }
    index += character.length;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { kind: 'rejected', reason: 'control_character', position: index };
    }
  }

  return { kind: 'accepted' };
}

/**
 * Wraps an identifier in an isolate pair so a right-to-left neighbour cannot
 * reorder it on screen. Isolates are used rather than the deprecated embedding
 * and override characters because an isolate cannot influence text outside it,
 * so a label built from several isolated parts stays predictable.
 */
export function isolateIdentifier(identifier: string): string {
  const inspection = inspectIdentifierText(identifier);
  if (inspection.kind === 'rejected') {
    throw new TypeError(`unsafe identifier: ${inspection.reason}`);
  }
  return `${LEFT_TO_RIGHT_ISOLATE}${identifier}${POP_DIRECTIONAL_ISOLATE}`;
}

export function stripDirectionalFormatting(value: string): string {
  return value.replace(ALL_DIRECTIONAL_FORMATTING, '');
}
