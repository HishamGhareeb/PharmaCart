import { applyAlertSignal, emptyAlertState, type AlertSeverity } from '../../alerting/src/alert-episode.ts';

/**
 * The last gate before anything leaves the system. `packages/alerting` builds the delivery payload
 * from the episode alone; this module re-checks the result at the boundary, because "by
 * construction" holds only until someone adds a field or edits a template.
 *
 * The check is an allowlist. A title must be one of the redacted titles the reducer produces and the
 * body must be its fixed instruction. An earlier denylist scanned the payload for the signal's own
 * strings: it missed anything the caller forgot to list (a quantity, a branch name) and refused safe
 * payloads whenever a product name happened to occur in the template or inside a random UUID.
 */

export type DeliveryPayloadDraft = Readonly<{
  episodeId: string;
  installationId: string;
  title: string;
  body: string;
}>;

export type SafeDeliveryPayload = DeliveryPayloadDraft;

export type PayloadViolation =
  | 'identifier_not_opaque'
  | 'field_not_string'
  | 'not_redacted_template'
  | 'unexpected_field';

export class UnsafePayloadError extends Error {
  readonly code = 'UNSAFE_DELIVERY_PAYLOAD';
  readonly violation: PayloadViolation;

  constructor(violation: PayloadViolation, field: string) {
    // The message names the field, never its value: an error string is also somewhere content leaks.
    super(`Delivery payload refused: ${violation} on ${field}`);
    this.name = 'UnsafePayloadError';
    this.violation = violation;
  }
}

const severities: readonly AlertSeverity[] = ['informational', 'actionable', 'critical'];

/**
 * Reads the templates from the reducer itself, once, with a synthetic signal that carries nothing.
 * Restating the strings here would let the two copies drift; an allowlist that drifted from the
 * reducer would refuse every real delivery, and one widened by hand would defeat the point.
 */
function reducerTemplates(): Readonly<{ titles: readonly string[]; body: string }> {
  const titles: string[] = [];
  const bodies = new Set<string>();
  for (const severity of severities) {
    const result = applyAlertSignal(emptyAlertState(), {
      signalId: 'template', installationId: 'template', conditionKey: 'template', severity,
      observedAt: '2000-01-01T00:00:00.000Z', subject: '', detail: '',
    }, { quietHours: { timeZone: 'UTC', startMinute: 0, endMinute: 0 }, bypassSeverities: severities });
    if (result.kind !== 'opened') throw new Error(`packages/alerting produced no redacted payload for ${severity}`);
    titles.push(result.delivery.payload.title);
    bodies.add(result.delivery.payload.body);
  }
  const [body] = [...bodies];
  if (bodies.size !== 1 || body === undefined) throw new Error('packages/alerting redacted body is not a single fixed instruction');
  return Object.freeze({ titles: Object.freeze([...new Set(titles)]), body });
}

const templates = reducerTemplates();

/** The only titles a delivery may carry, as produced by `packages/alerting`. */
export const REDACTED_TITLES: readonly string[] = templates.titles;
/** The only body a delivery may carry, as produced by `packages/alerting`. */
export const REDACTED_BODY: string = templates.body;

/** RFC 4122 text form. Anything readable - a slug, a branch name, a sequence - is refused. */
const opaqueIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireOpaque(value: string, field: string): string {
  if (typeof value !== 'string' || !opaqueIdentifier.test(value)) {
    throw new UnsafePayloadError('identifier_not_opaque', field);
  }
  return value;
}

function requireTemplate(value: string, field: string, allowed: readonly string[]): string {
  if (typeof value !== 'string') throw new UnsafePayloadError('field_not_string', field);
  if (!allowed.includes(value)) throw new UnsafePayloadError('not_redacted_template', field);
  return value;
}

/**
 * Builds the payload that may be handed to a delivery sink. The result is assembled field by field,
 * so an unexpected property on the draft is dropped rather than forwarded.
 */
export function sealDeliveryPayload(draft: DeliveryPayloadDraft): SafeDeliveryPayload {
  return Object.freeze({
    episodeId: requireOpaque(draft.episodeId, 'episodeId'),
    installationId: requireOpaque(draft.installationId, 'installationId'),
    title: requireTemplate(draft.title, 'title', REDACTED_TITLES),
    body: requireTemplate(draft.body, 'body', [REDACTED_BODY]),
  });
}

/**
 * Re-checks an already sealed payload at a second boundary, such as a delivery adapter that did not
 * build it. Returns the violation instead of throwing so a transport can record why it refused.
 */
export function inspectDeliveryPayload(value: unknown): PayloadViolation | null {
  if (typeof value !== 'object' || value === null) return 'unexpected_field';
  const keys = Object.keys(value).sort();
  const expected = ['body', 'episodeId', 'installationId', 'title'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return 'unexpected_field';
  }
  try {
    sealDeliveryPayload(value as DeliveryPayloadDraft);
    return null;
  } catch (error) {
    return error instanceof UnsafePayloadError ? error.violation : 'unexpected_field';
  }
}
