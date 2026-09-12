import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectUntrustedXml, type XmlSafetyLimits } from '../src/xml-safety.ts';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function rejectionReason(text: string, limits?: Partial<XmlSafetyLimits>): string {
  const decision = limits === undefined
    ? inspectUntrustedXml(bytes(text))
    : inspectUntrustedXml(bytes(text), limits);
  assert.equal(decision.kind, 'rejected', `expected rejection for ${JSON.stringify(text.slice(0, 60))}`);
  return decision.kind === 'rejected' ? decision.reason : '';
}

const benign = '<?xml version="1.0" encoding="UTF-8"?>\n<stock><line qty="4">Syntheticol 10 mg</line></stock>';

describe('untrusted XML inspection', () => {
  it('accepts a declared UTF-8 document and reports its shape', () => {
    const decision = inspectUntrustedXml(bytes(benign));
    assert.equal(decision.kind, 'accepted');
    assert.equal(decision.kind === 'accepted' ? decision.elementCount : 0, 2);
    assert.equal(decision.kind === 'accepted' ? decision.maxDepth : 0, 2);
  });

  it('accepts comments, CDATA and self-closing elements without counting them as nesting', () => {
    const decision = inspectUntrustedXml(
      bytes('<stock><!-- <!DOCTYPE evil> --><line/><note><![CDATA[<!ENTITY x>]]></note></stock>'),
    );
    assert.equal(decision.kind, 'accepted');
    assert.equal(decision.kind === 'accepted' ? decision.maxDepth : 0, 2);
    assert.equal(decision.kind === 'accepted' ? decision.elementCount : 0, 3);
  });

  it('rejects any document type or entity declaration', () => {
    assert.equal(
      rejectionReason('<!DOCTYPE stock SYSTEM "http://attacker.example/x.dtd"><stock/>'),
      'doctype_declaration',
    );
    assert.equal(
      rejectionReason('<!DOCTYPE stock [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><stock>&xxe;</stock>'),
      'doctype_declaration',
    );
    assert.equal(rejectionReason('<!ENTITY lol "lollol"><stock/>'), 'entity_declaration');
    assert.equal(rejectionReason('<!NOTATION gif PUBLIC "x"><stock/>'), 'markup_declaration');
  });

  it('rejects entity expansion payloads regardless of nesting', () => {
    const billionLaughs = [
      '<!DOCTYPE lolz [',
      '<!ENTITY lol "lol">',
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      ']>',
      '<lolz>&lol2;</lolz>',
    ].join('');
    assert.equal(rejectionReason(billionLaughs), 'doctype_declaration');
  });

  it('rejects unknown named entity references while allowing predefined and numeric ones', () => {
    assert.equal(rejectionReason('<stock>&xxe;</stock>'), 'external_entity_reference');
    const decision = inspectUntrustedXml(bytes('<stock>&amp;&lt;&gt;&quot;&apos;&#48;&#x41;</stock>'));
    assert.equal(decision.kind, 'accepted');
  });

  it('rejects processing instructions other than the leading XML declaration', () => {
    assert.equal(
      rejectionReason('<?xml version="1.0"?><?xml-stylesheet href="file:///etc/passwd"?><stock/>'),
      'processing_instruction',
    );
    assert.equal(rejectionReason('<stock><?php echo 1; ?></stock>'), 'processing_instruction');
  });

  it('rejects XInclude external references', () => {
    assert.equal(
      rejectionReason('<stock xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></stock>'),
      'xinclude_reference',
    );
  });

  it('rejects encodings other than UTF-8 rather than scanning a partial view', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00]);
    const decision = inspectUntrustedXml(utf16);
    assert.equal(decision.kind, 'rejected');
    assert.equal(decision.kind === 'rejected' ? decision.reason : '', 'unsupported_encoding');
    assert.equal(rejectionReason('<?xml version="1.0" encoding="UTF-16"?><stock/>'), 'unsupported_encoding');
    assert.equal(
      inspectUntrustedXml(new Uint8Array([0xc3, 0x28, 0x3c, 0x61, 0x2f, 0x3e])).kind,
      'rejected',
    );
  });

  it('accepts a UTF-8 byte order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<stock/>')]);
    assert.equal(inspectUntrustedXml(withBom).kind, 'accepted');
  });

  it('bounds document size, nesting depth and element count', () => {
    assert.equal(rejectionReason('', {}), 'empty_document');
    assert.equal(rejectionReason(benign, { maxBytes: 16 }), 'document_too_large');
    const deep = `${'<a>'.repeat(70)}${'</a>'.repeat(70)}`;
    assert.equal(rejectionReason(deep, { maxDepth: 64 }), 'depth_limit_exceeded');
    const wide = `<stock>${'<line/>'.repeat(40)}</stock>`;
    assert.equal(rejectionReason(wide, { maxElements: 10 }), 'element_limit_exceeded');
  });

  it('rejects unterminated and unbalanced markup instead of guessing', () => {
    assert.equal(rejectionReason('<stock><!-- never closed'), 'unterminated_construct');
    assert.equal(rejectionReason('<stock><![CDATA[ never closed'), 'unterminated_construct');
    assert.equal(rejectionReason('<stock attr="never closed'), 'unterminated_construct');
    assert.equal(rejectionReason('<stock></stock></stock>'), 'unbalanced_element');
    assert.equal(rejectionReason('<stock>'), 'unbalanced_element');
    assert.equal(rejectionReason('   '), 'no_root_element');
  });
});
