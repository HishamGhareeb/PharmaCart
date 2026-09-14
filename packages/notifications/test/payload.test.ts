import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inspectDeliveryPayload,
  REDACTED_BODY,
  REDACTED_TITLES,
  sealDeliveryPayload,
  UnsafePayloadError,
  type DeliveryPayloadDraft,
} from '../src/payload.ts';
import { applyAlertSignal, emptyAlertState, type AlertSeverity } from '../../alerting/src/alert-episode.ts';

// What leaves the system is the only part of this module a stranger can read from a lock screen.
// These tests treat the payload as hostile output: the assertion is about what cannot be in it.

const episodeId = '70000000-0000-4000-8000-000000000001';
const installationId = '50000000-0000-4000-8000-000000000001';

const draft: DeliveryPayloadDraft = {
  episodeId,
  installationId,
  title: 'Urgent stock issue',
  body: 'Open PharmaCart to review this alert.',
};

function violation(input: DeliveryPayloadDraft): string {
  try {
    sealDeliveryPayload(input);
  } catch (error) {
    assert.ok(error instanceof UnsafePayloadError, `expected UnsafePayloadError, received ${String(error)}`);
    assert.equal(error.code, 'UNSAFE_DELIVERY_PAYLOAD');
    return error.violation;
  }
  assert.fail('expected the payload to be refused');
}

/** What packages/alerting itself builds for one severity, so the allowlist is checked against the source. */
function reducerPayload(severity: AlertSeverity) {
  const result = applyAlertSignal(emptyAlertState(), {
    signalId: 's', installationId, conditionKey: 'c', severity,
    observedAt: '2026-09-12T12:00:00.000Z', subject: 'Amoxicillin 500mg', detail: 'On hand 2 of target 10',
  }, { quietHours: { timeZone: 'UTC', startMinute: 0, endMinute: 0 }, bypassSeverities: [] });
  assert.equal(result.kind, 'opened');
  if (result.kind !== 'opened') throw new Error('unreachable');
  return result.delivery.payload;
}

describe('delivery payload sealing', () => {
  it('seals exactly four fields and nothing else', () => {
    const sealed = sealDeliveryPayload(draft);
    assert.deepEqual(Object.keys(sealed).sort(), ['body', 'episodeId', 'installationId', 'title']);
    assert.equal(Object.isFrozen(sealed), true);
  });

  it('derives its allowlist from packages/alerting rather than restating it', () => {
    for (const severity of ['informational', 'actionable', 'critical'] as const) {
      const payload = reducerPayload(severity);
      assert.ok(REDACTED_TITLES.includes(payload.title), `${severity} title must be allowed`);
      assert.equal(payload.body, REDACTED_BODY);
      assert.doesNotThrow(() => sealDeliveryPayload({ ...payload, episodeId, installationId }));
    }
    assert.equal(REDACTED_TITLES.length, 3);
  });

  it('drops any extra field a later edit adds to the draft', () => {
    const widened = { ...draft, productName: 'Amoxicillin 500mg', quantity: '3' } as DeliveryPayloadDraft;
    const sealed = sealDeliveryPayload(widened);
    assert.equal(Object.keys(sealed).length, 4);
    assert.equal(JSON.stringify(sealed).includes('Amoxicillin'), false);
    assert.equal(JSON.stringify(sealed).includes('quantity'), false);
  });

  // Regression, finding P1. The lane refused only strings the caller remembered to list, at least
  // three characters long. A quantity, a branch name or any product text not in that list reached
  // the provider. Only the redacted templates may be sent now, whatever the caller forgot.
  it('refuses a title or body that is not a redacted template, even when no leaked value was listed', () => {
    assert.equal(violation({ ...draft, title: 'Stock needs attention: 2 left' }), 'not_redacted_template');
    assert.equal(violation({ ...draft, body: 'Restock at Nile Corniche Pharmacy' }), 'not_redacted_template');
    assert.equal(violation({ ...draft, title: 'Amoxicillin 500mg is low' }), 'not_redacted_template');
    assert.equal(violation({ ...draft, body: 'open pharmacart to review this alert.' }), 'not_redacted_template');
  });

  // Regression, finding P2. The lane scanned the serialised payload for each signal string. A
  // product named "PharmaCart", "Stock" or "review", or a short hex-looking code that happens to
  // occur inside a random UUID, matched the fixed template or an identifier, the seal threw, and
  // the whole acceptance transaction rolled back: the alert was lost to a privacy false positive.
  it('does not refuse a safe payload because signal text happens to occur inside the template or an identifier', () => {
    const sealed = sealDeliveryPayload(draft);
    assert.equal(sealed.body, REDACTED_BODY);
    // The payload contains these substrings; they are template text and opaque identifiers, not leaks.
    for (const fragment of ['PharmaCart', 'Stock', 'review', '0000', '4000-8000']) {
      assert.ok(JSON.stringify(sealed).toLowerCase().includes(fragment.toLowerCase()));
    }
  });

  it('requires opaque identifiers rather than readable references', () => {
    assert.equal(violation({ ...draft, episodeId: 'ep-1' }), 'identifier_not_opaque');
    assert.equal(violation({ ...draft, installationId: 'branch:cairo-main' }), 'identifier_not_opaque');
    assert.equal(violation({ ...draft, episodeId: '' }), 'identifier_not_opaque');
  });

  it('refuses a non-string field arriving from an untyped caller', () => {
    assert.equal(violation({ ...draft, title: 42 as unknown as string }), 'field_not_string');
    assert.equal(violation({ ...draft, body: null as unknown as string }), 'field_not_string');
  });

  it('refuses control characters and newlines that could forge a second notification line', () => {
    assert.equal(violation({ ...draft, title: 'Stock\nupdate' }), 'not_redacted_template');
    assert.equal(violation({ ...draft, body: `${REDACTED_BODY}${String.fromCharCode(7)}` }), 'not_redacted_template');
  });

  it('inspects an already sealed payload at a second boundary and names the violation', () => {
    assert.equal(inspectDeliveryPayload(sealDeliveryPayload(draft)), null);
    assert.equal(inspectDeliveryPayload({ ...draft, productName: 'x' }), 'unexpected_field');
    assert.equal(inspectDeliveryPayload({ ...draft, title: 'Amoxicillin low' }), 'not_redacted_template');
    assert.equal(inspectDeliveryPayload(null), 'unexpected_field');
  });
});
