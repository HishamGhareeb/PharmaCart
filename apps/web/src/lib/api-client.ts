import { assertLoopbackOrigin } from './config.ts';
import { requireUuid } from './validation.ts';

/**
 * Server-side client for the existing local PharmaCart API.
 *
 * Only this module talks to the API, and only from the server. The base URL is pinned to a loopback
 * origin at construction time and every path is built from validated canonical UUIDs, so no request
 * input can ever redirect a call somewhere else. Browser cookies are never forwarded and redirects
 * are refused rather than followed.
 */

export type ApiAuth = Readonly<{ accessToken: string; organisationId: string; branchId: string }>;
export type ApiResult = { status: number; body: unknown };

export type QuoteCommand = Readonly<{
  branchId: string;
  lines: readonly { needId: string; needVersion: number; quantity: string; unit: string }[];
  constraints: { supplierIds: readonly string[]; paymentTerm: 'cash' };
}>;

export type ReceiptCommand = Readonly<{
  reference: string;
  lines: readonly { lineId: string; quantity: string }[];
}>;

export type ApiClient = {
  getContext(auth: ApiAuth): Promise<ApiResult>;
  getNeed(auth: ApiAuth, needId: string): Promise<ApiResult>;
  createQuote(auth: ApiAuth, command: QuoteCommand): Promise<ApiResult>;
  approveQuote(auth: ApiAuth, quoteId: string, body: { quoteVersion: number }, idempotencyKey: string): Promise<ApiResult>;
  getOrder(auth: ApiAuth, orderId: string): Promise<ApiResult>;
  confirmReceipt(auth: ApiAuth, orderId: string, command: ReceiptCommand): Promise<ApiResult>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function upstreamUnavailable(status: number): ApiResult {
  return {
    status,
    body: {
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'The local PharmaCart API did not return a JSON response.',
        correlationId: null,
      },
    },
  };
}

export function createApiClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ApiClient {
  const baseUrl = assertLoopbackOrigin(options.baseUrl, 'API base URL');
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function scopeHeaders(auth: ApiAuth): Record<string, string> {
    return {
      authorization: `Bearer ${auth.accessToken}`,
      'x-organisation-id': requireUuid(auth.organisationId, 'Organisation identifier'),
      'x-branch-id': requireUuid(auth.branchId, 'Branch identifier'),
      accept: 'application/json',
    };
  }

  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; auth: ApiAuth; body?: unknown; idempotencyKey?: string },
  ): Promise<ApiResult> {
    const headers: Record<string, string> = scopeHeaders(init.auth);
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

    const response = await call(`${baseUrl}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (text === '') return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return upstreamUnavailable(response.status >= 400 ? response.status : 502);
    }
  }

  // Every method is async so a refused identifier surfaces as a rejected promise, never as a throw
  // that escapes the caller's error handling.
  return {
    async getContext(auth) {
      return request('/v1/context', { method: 'GET', auth });
    },

    async getNeed(auth, needId) {
      return request(`/v1/needs/${requireUuid(needId, 'Need identifier')}`, { method: 'GET', auth });
    },

    async createQuote(auth, command) {
      return request('/v1/quotes', { method: 'POST', auth, body: command });
    },

    async approveQuote(auth, quoteId, body, idempotencyKey) {
      return request(`/v1/quotes/${requireUuid(quoteId, 'Quote identifier')}/approve`, {
        method: 'POST',
        auth,
        body,
        idempotencyKey,
      });
    },

    async getOrder(auth, orderId) {
      return request(`/v1/orders/${requireUuid(orderId, 'Order identifier')}`, { method: 'GET', auth });
    },

    async confirmReceipt(auth, orderId, command) {
      return request(`/v1/orders/${requireUuid(orderId, 'Order identifier')}/receipts`, {
        method: 'POST',
        auth,
        body: command,
      });
    },
  };
}
