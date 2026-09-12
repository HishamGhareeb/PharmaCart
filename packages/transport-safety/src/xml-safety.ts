export type XmlRejectionReason =
  | 'empty_document'
  | 'document_too_large'
  | 'unsupported_encoding'
  | 'invalid_utf8'
  | 'doctype_declaration'
  | 'entity_declaration'
  | 'markup_declaration'
  | 'external_entity_reference'
  | 'processing_instruction'
  | 'xinclude_reference'
  | 'unterminated_construct'
  | 'unbalanced_element'
  | 'depth_limit_exceeded'
  | 'element_limit_exceeded'
  | 'no_root_element';

export type XmlSafetyLimits = Readonly<{
  maxBytes: number;
  maxDepth: number;
  maxElements: number;
}>;

export type XmlSafetyDecision =
  | Readonly<{ kind: 'accepted'; text: string; elementCount: number; maxDepth: number }>
  | Readonly<{ kind: 'rejected'; reason: XmlRejectionReason }>;

export const DEFAULT_XML_SAFETY_LIMITS: XmlSafetyLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxElements: 100_000,
};

const XINCLUDE_NAMESPACE = 'http://www.w3.org/2001/XInclude';
const PREDEFINED_ENTITIES: ReadonlySet<string> = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const ENTITY_REFERENCE = /&([^;\s&<]{1,64});/g;
const NUMERIC_ENTITY = /^#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6})$/;
const ENCODING_DECLARATION = /<\?xml[^>]*?encoding\s*=\s*["']([^"']*)["']/;
const XINCLUDE_ELEMENT = /^<\s*[A-Za-z_][\w.-]*:include[\s/>]/;

type TagBounds = Readonly<{ end: number; selfClosing: boolean; raw: string }>;

export function inspectUntrustedXml(
  source: Uint8Array,
  limits: Partial<XmlSafetyLimits> = {},
): XmlSafetyDecision {
  const maxBytes = limits.maxBytes ?? DEFAULT_XML_SAFETY_LIMITS.maxBytes;
  const maxDepth = limits.maxDepth ?? DEFAULT_XML_SAFETY_LIMITS.maxDepth;
  const maxElements = limits.maxElements ?? DEFAULT_XML_SAFETY_LIMITS.maxElements;

  if (source.byteLength === 0) {
    return reject('empty_document');
  }
  if (source.byteLength > maxBytes) {
    return reject('document_too_large');
  }
  if (hasNonUtf8ByteOrderMark(source) || source.includes(0x00)) {
    return reject('unsupported_encoding');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    return reject('invalid_utf8');
  }

  const declaredEncoding = ENCODING_DECLARATION.exec(text)?.[1];
  if (declaredEncoding !== undefined && !/^utf-?8$/i.test(declaredEncoding)) {
    return reject('unsupported_encoding');
  }

  return scanMarkup(text, maxDepth, maxElements);
}

function scanMarkup(text: string, maxDepth: number, maxElements: number): XmlSafetyDecision {
  let index = 0;
  let depth = 0;
  let maxDepthSeen = 0;
  let elementCount = 0;
  let sawRootElement = false;

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (hasForeignEntityReference(text.slice(index, open === -1 ? text.length : open))) {
      return reject('external_entity_reference');
    }
    if (open === -1) {
      break;
    }
    index = open;

    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end === -1) {
        return reject('unterminated_construct');
      }
      index = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      if (end === -1) {
        return reject('unterminated_construct');
      }
      index = end + 3;
      continue;
    }

    if (text.startsWith('<!DOCTYPE', index)) {
      return reject('doctype_declaration');
    }
    if (text.startsWith('<!ENTITY', index)) {
      return reject('entity_declaration');
    }
    if (text.startsWith('<!', index)) {
      return reject('markup_declaration');
    }

    if (text.startsWith('<?', index)) {
      if (!isLeadingXmlDeclaration(text, index)) {
        return reject('processing_instruction');
      }
      const end = text.indexOf('?>', index + 5);
      if (end === -1) {
        return reject('unterminated_construct');
      }
      index = end + 2;
      continue;
    }

    if (text.startsWith('</', index)) {
      const end = text.indexOf('>', index);
      if (end === -1) {
        return reject('unterminated_construct');
      }
      depth -= 1;
      if (depth < 0) {
        return reject('unbalanced_element');
      }
      index = end + 1;
      continue;
    }

    const tag = readTag(text, index);
    if (tag === undefined) {
      return reject('unterminated_construct');
    }

    elementCount += 1;
    if (elementCount > maxElements) {
      return reject('element_limit_exceeded');
    }
    if (tag.raw.includes(XINCLUDE_NAMESPACE) || XINCLUDE_ELEMENT.test(tag.raw)) {
      return reject('xinclude_reference');
    }
    if (hasForeignEntityReference(tag.raw)) {
      return reject('external_entity_reference');
    }

    sawRootElement = true;
    const openedDepth = depth + 1;
    if (openedDepth > maxDepth) {
      return reject('depth_limit_exceeded');
    }
    maxDepthSeen = Math.max(maxDepthSeen, openedDepth);
    if (!tag.selfClosing) {
      depth = openedDepth;
    }
    index = tag.end + 1;
  }

  if (depth !== 0) {
    return reject('unbalanced_element');
  }
  if (!sawRootElement) {
    return reject('no_root_element');
  }

  return { kind: 'accepted', text, elementCount, maxDepth: maxDepthSeen };
}

function readTag(text: string, start: number): TagBounds | undefined {
  let quote = '';
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote !== '') {
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') {
      return {
        end: cursor,
        selfClosing: text[cursor - 1] === '/',
        raw: text.slice(start, cursor + 1),
      };
    }
  }
  return undefined;
}

function isLeadingXmlDeclaration(text: string, index: number): boolean {
  return text.slice(0, index).trim().length === 0
    && /^<\?xml[\s?]/.test(text.slice(index, index + 6));
}

function hasForeignEntityReference(chunk: string): boolean {
  ENTITY_REFERENCE.lastIndex = 0;
  for (;;) {
    const match = ENTITY_REFERENCE.exec(chunk);
    if (match === null) {
      return false;
    }
    const name = match[1] ?? '';
    if (!PREDEFINED_ENTITIES.has(name) && !NUMERIC_ENTITY.test(name)) {
      return true;
    }
  }
}

function hasNonUtf8ByteOrderMark(source: Uint8Array): boolean {
  if (source.byteLength < 2) {
    return false;
  }
  const leadsWith = (first: number, second: number): boolean =>
    source[0] === first && source[1] === second;
  return leadsWith(0xff, 0xfe) || leadsWith(0xfe, 0xff);
}

function reject(reason: XmlRejectionReason): XmlSafetyDecision {
  return { kind: 'rejected', reason };
}
