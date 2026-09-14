import type { ApiAuth, ApiClient, ApiResult } from '../api-client.ts';
import {
  LOGIN_COOKIE,
  MAX_BFF_BODY_BYTES,
  PENDING_LOGIN_SECONDS,
  SESSION_COOKIE,
  type WebConfig,
} from '../config.ts';
import { clearCookie, parseCookies, serializeCookie } from '../cookies.ts';
import { guardStateChangingRequest } from '../csrf.ts';
import {
  SYNTHETIC_SALE_UNIT,
  findScopeOption,
  findSupplierOption,
} from '../fixtures.ts';
import type { OidcClient } from '../oidc.ts';
import { toSessionView, type SessionStore, type WebSession } from '../session.ts';
import { InvalidInputError, isPositiveDecimal, isPositiveInteger, isRecord, isUuid } from '../validation.ts';

/**
 * The backend-for-frontend.
 *
 * The browser never sees a token: it holds only an opaque HttpOnly session cookie plus a CSRF token
 * for this session. Every mutating call is refused unless it is same-origin and carries that token.
 * Nothing here dispatches to a supplier or advances an order; it only relays operator intent to the
 * existing local API.
 */

export type BffDependencies = {
  config: WebConfig;
  sessions: SessionStore;
  api: ApiClient;
  oidc: OidcClient;
};

export type BffRouter = {
  beginLogin(request: Request): Promise<Response>;
  completeLogin(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  readSession(request: Request): Promise<Response>;
  selectScope(request: Request): Promise<Response>;
  readNeed(request: Request, needId: string): Promise<Response>;
  requestQuote(request: Request): Promise<Response>;
  approveQuote(request: Request, quoteId: string): Promise<Response>;
  readOrder(request: Request, orderId: string): Promise<Response>;
  confirmReceipt(request: Request, orderId: string): Promise<Response>;
};

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extra },
  });
}

function failure(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: { code, message, correlationId: null } }, extra);
}

function relay(result: ApiResult): Response {
  return json(result.status, result.body);
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

class BffError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super('bff refusal');
    this.response = response;
  }
}

function tooLarge(): BffError {
  return new BffError(failure(413, 'PAYLOAD_TOO_LARGE', 'The request body is larger than this app accepts.'));
}

/**
 * Reads at most MAX_BFF_BODY_BYTES of the body.
 *
 * The bound has to hold against the bytes that were actually sent. Reading the body whole and then
 * measuring its string length buffers a multi-megabyte POST in full before refusing it, and counts
 * UTF-16 code units, which lets a multi-byte body run to several times the bound. So: refuse a
 * declared Content-Length over the bound up front, then count bytes as they arrive and abandon the
 * stream the moment the running total passes it.
 */
async function readBoundedText(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BFF_BODY_BYTES)) {
    throw tooLarge();
  }

  const body = request.body;
  if (body === null) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BFF_BODY_BYTES) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Abandon whatever is left rather than draining a body this app has already refused.
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

/** Reads a bounded JSON body. An oversized or malformed body is refused before any work happens. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === '' ? '{}' : text);
  } catch {
    throw new BffError(failure(400, 'INVALID_JSON', 'The request body is not valid JSON.'));
  }
  if (!isRecord(parsed)) {
    throw new BffError(failure(400, 'INVALID_REQUEST', 'The request body must be a JSON object.'));
  }
  return parsed;
}

export function createBffRouter(deps: BffDependencies): BffRouter {
  const { config, sessions, api, oidc } = deps;

  function currentSession(request: Request): WebSession | null {
    return sessions.get(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]);
  }

  function requireSession(request: Request): WebSession {
    const session = currentSession(request);
    if (!session) {
      throw new BffError(
        failure(
          401,
          'UNAUTHENTICATED',
          'This browser has no live PharmaCart session. Sign in again.',
          { 'set-cookie': clearCookie(SESSION_COOKIE) },
        ),
      );
    }
    return session;
  }

  /** Refuses a foreign Origin before any session lookup, so a cross-site POST learns nothing at all. */
  function requireOrigin(request: Request): void {
    const guard = guardStateChangingRequest(request, { allowedOrigin: config.webOrigin, csrfToken: null });
    if (!guard.ok && guard.code === 'FOREIGN_ORIGIN') {
      throw new BffError(failure(guard.status, guard.code, guard.message));
    }
  }

  function requireGuard(request: Request, session: WebSession): void {
    const guard = guardStateChangingRequest(request, {
      allowedOrigin: config.webOrigin,
      csrfToken: session.csrfToken,
    });
    if (!guard.ok) throw new BffError(failure(guard.status, guard.code, guard.message));
  }

  function requireAuth(session: WebSession): ApiAuth {
    if (!session.scope) {
      throw new BffError(
        failure(400, 'SCOPE_REQUIRED', 'Choose a synthetic organisation and branch before using the purchase loop.'),
      );
    }
    return {
      accessToken: session.accessToken,
      organisationId: session.scope.organisationId,
      branchId: session.scope.branchId,
    };
  }

  function requireIdentifier(value: string, label: string): string {
    if (!isUuid(value)) {
      throw new BffError(failure(400, 'INVALID_REQUEST', `${label} must be a canonical UUID.`));
    }
    return value;
  }

  /** An upstream transport failure is reported as uncertain, never as a completed or failed command. */
  async function relayCall(operation: () => Promise<ApiResult>, subject: string): Promise<Response> {
    try {
      return relay(await operation());
    } catch (error) {
      if (error instanceof InvalidInputError) {
        return failure(400, error.code, error.message);
      }
      return failure(
        502,
        'UPSTREAM_UNAVAILABLE',
        `The local PharmaCart API could not be reached, so the ${subject} outcome is unknown.`,
      );
    }
  }

  async function handle(work: () => Promise<Response>): Promise<Response> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BffError) return error.response;
      if (error instanceof InvalidInputError) return failure(400, error.code, error.message);
      throw error;
    }
  }

  return {
    beginLogin(request) {
      return handle(async () => {
        void request;
        let authorization;
        try {
          authorization = await oidc.createAuthorizationRequest();
        } catch {
          // The local provider is not running or answered badly. Say so on the sign-in page instead
          // of surfacing a framework error, and start no login at all.
          return redirect(`${config.webOrigin}/?authError=LOGIN_PROVIDER_UNAVAILABLE`, []);
        }
        const handleId = sessions.createPendingLogin({
          state: authorization.state,
          codeVerifier: authorization.codeVerifier,
        });
        // Only an opaque handle reaches the browser; the state and PKCE verifier stay on the server.
        return redirect(authorization.url, [
          serializeCookie(LOGIN_COOKIE, handleId, { maxAgeSeconds: PENDING_LOGIN_SECONDS }),
        ]);
      });
    },

    completeLogin(request) {
      return handle(async () => {
        const url = new URL(request.url);
        const handleId = parseCookies(request.headers.get('cookie'))[LOGIN_COOKIE];
        const pending = handleId ? sessions.takePendingLogin(handleId) : null;
        const refuse = (code: string) =>
          redirect(`${config.webOrigin}/?authError=${code}`, [clearCookie(LOGIN_COOKIE)]);

        if (url.searchParams.get('error')) return refuse('LOGIN_REFUSED');
        if (!pending) return refuse('LOGIN_STATE_MISSING');

        const state = url.searchParams.get('state');
        if (state === null || state !== pending.state) return refuse('LOGIN_STATE_MISMATCH');

        const code = url.searchParams.get('code');
        if (!code) return refuse('LOGIN_CODE_MISSING');

        let tokens;
        try {
          tokens = await oidc.exchangeAuthorizationCode({ code, codeVerifier: pending.codeVerifier });
        } catch {
          return refuse('LOGIN_EXCHANGE_FAILED');
        }

        const session = sessions.create({
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: sessions.now() + tokens.expiresInSeconds * 1000,
        });
        const lifetimeSeconds = Math.max(1, Math.floor((session.expiresAt - sessions.now()) / 1000));
        return redirect(`${config.webOrigin}/purchase`, [
          clearCookie(LOGIN_COOKIE),
          serializeCookie(SESSION_COOKIE, session.id, { maxAgeSeconds: lifetimeSeconds }),
        ]);
      });
    },

    logout(request) {
      return handle(async () => {
        requireOrigin(request);
        const session = currentSession(request);
        if (!session) {
          return new Response(null, { status: 204, headers: { ...NO_STORE, 'set-cookie': clearCookie(SESSION_COOKIE) } });
        }
        requireGuard(request, session);
        sessions.destroy(session.id);
        return new Response(null, { status: 204, headers: { ...NO_STORE, 'set-cookie': clearCookie(SESSION_COOKIE) } });
      });
    },

    readSession(request) {
      return handle(async () => {
        const session = requireSession(request);
        return json(200, { session: toSessionView(session) });
      });
    },

    selectScope(request) {
      return handle(async () => {
        requireOrigin(request);
        const session = requireSession(request);
        requireGuard(request, session);
        const body = await readBody(request);
        const option = findScopeOption(body.organisationId, body.branchId);
        if (!option) {
          return failure(
            400,
            'UNKNOWN_SCOPE',
            'Choose one of the seeded synthetic organisation and branch pairs.',
          );
        }

        let result: ApiResult;
        try {
          result = await api.getContext({
            accessToken: session.accessToken,
            organisationId: option.organisationId,
            branchId: option.branchId,
          });
        } catch {
          return failure(502, 'UPSTREAM_UNAVAILABLE', 'The local PharmaCart API could not be reached.');
        }
        if (result.status !== 200 || !isRecord(result.body)) return relay(result);

        const context = result.body;
        session.scope = {
          organisationId: option.organisationId,
          branchId: option.branchId,
          organisationKind: String(context.organisationKind ?? ''),
          role: String(context.role ?? ''),
        };
        // Only the API knows who this token belongs to: it reports the subject it verified itself.
        // Falling back to the subject the seed script pairs with this scope would put a fabricated
        // identity behind "Signed in as", which is exactly the kind of invented backend data the
        // fixture list exists to avoid.
        session.subject = typeof context.userSubject === 'string' ? context.userSubject : null;
        return json(200, { session: toSessionView(session), context });
      });
    },

    readNeed(request, needId) {
      return handle(async () => {
        const session = requireSession(request);
        const auth = requireAuth(session);
        requireIdentifier(needId, 'The need identifier');
        return relayCall(() => api.getNeed(auth, needId), 'need lookup');
      });
    },

    requestQuote(request) {
      return handle(async () => {
        requireOrigin(request);
        const session = requireSession(request);
        requireGuard(request, session);
        const body = await readBody(request);
        const auth = requireAuth(session);

        const { needId, needVersion, quantity } = body;
        if (!isUuid(needId)) {
          return failure(400, 'INVALID_REQUEST', 'The need identifier must be a canonical UUID.');
        }
        if (!isPositiveInteger(needVersion)) {
          return failure(400, 'INVALID_REQUEST', 'The need version must be a positive whole number.');
        }
        if (!isPositiveDecimal(quantity)) {
          return failure(400, 'INVALID_REQUEST', 'The quantity must be a positive canonical decimal.');
        }
        const supplier = findSupplierOption(body.supplierKey);
        if (!supplier) {
          return failure(400, 'UNKNOWN_SUPPLIER', 'Choose one of the seeded synthetic supplier constraints.');
        }

        // Box-only: the seeded catalogue has a single sale unit and the API exposes no unit metadata.
        const command = {
          branchId: auth.branchId,
          lines: [{ needId, needVersion, quantity, unit: SYNTHETIC_SALE_UNIT }],
          constraints: {
            supplierIds: supplier.supplierId === null ? [] : [supplier.supplierId],
            paymentTerm: 'cash' as const,
          },
        };
        return relayCall(() => api.createQuote(auth, command), 'quote');
      });
    },

    approveQuote(request, quoteId) {
      return handle(async () => {
        requireOrigin(request);
        const session = requireSession(request);
        requireGuard(request, session);
        const body = await readBody(request);
        const auth = requireAuth(session);
        requireIdentifier(quoteId, 'The quote identifier');

        const quoteVersion = body.quoteVersion;
        if (!isPositiveInteger(quoteVersion)) {
          return failure(400, 'INVALID_REQUEST', 'The quote version must be a positive whole number.');
        }

        // One key per quote version for the life of the session: a retry of the same human approval
        // reuses it, while a re-quote produces a new key and therefore needs a new human approval.
        const idempotencyKey = sessions.approvalKey(session.id, quoteId, quoteVersion);
        return relayCall(() => api.approveQuote(auth, quoteId, { quoteVersion }, idempotencyKey), 'approval');
      });
    },

    readOrder(request, orderId) {
      return handle(async () => {
        const session = requireSession(request);
        const auth = requireAuth(session);
        requireIdentifier(orderId, 'The order identifier');
        return relayCall(() => api.getOrder(auth, orderId), 'order lookup');
      });
    },

    confirmReceipt(request, orderId) {
      return handle(async () => {
        requireOrigin(request);
        const session = requireSession(request);
        requireGuard(request, session);
        const body = await readBody(request);
        const auth = requireAuth(session);
        requireIdentifier(orderId, 'The order identifier');

        const raw = body.lines;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
          return failure(400, 'INVALID_REQUEST', 'A receipt needs between one and one hundred lines.');
        }
        const lines: { lineId: string; quantity: string }[] = [];
        for (const line of raw) {
          if (!isRecord(line) || !isUuid(line.lineId) || !isPositiveDecimal(line.quantity)) {
            return failure(
              400,
              'INVALID_REQUEST',
              'Each receipt line needs a canonical line UUID and a positive canonical decimal quantity.',
            );
          }
          lines.push({ lineId: line.lineId, quantity: line.quantity });
        }
        if (new Set(lines.map((line) => line.lineId)).size !== lines.length) {
          return failure(400, 'INVALID_REQUEST', 'Each order line may appear only once in a receipt.');
        }

        // The reference is derived once per session from the intent and the exact quantities, so a
        // retry of the same confirmation is idempotent while a different quantity is a new receipt.
        const reference = sessions.receiptReference(session.id, orderId, lines);
        let result: ApiResult;
        try {
          result = await api.confirmReceipt(auth, orderId, { reference, lines });
        } catch {
          return failure(
            502,
            'UPSTREAM_UNAVAILABLE',
            'The local PharmaCart API could not be reached, so the receipt outcome is unknown.',
          );
        }
        if (result.status === 200 && isRecord(result.body)) {
          return json(200, { ...result.body, reference });
        }
        return relay(result);
      });
    },
  };
}
