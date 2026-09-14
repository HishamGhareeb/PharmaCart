import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiResult } from '../../src/lib/api-client.ts';
import { createBffRouter, type BffRouter } from '../../src/lib/bff/router.ts';
import { MAX_BFF_BODY_BYTES, loadWebConfig } from '../../src/lib/config.ts';
import { createInMemorySessionStore, type SessionStore } from '../../src/lib/session.ts';
import { SYNTHETIC_NEED_ID, SYNTHETIC_SCOPES, SYNTHETIC_SUPPLIERS } from '../../src/lib/fixtures.ts';

const ORIGIN = 'http://127.0.0.1:3001';
const START = 1_800_000_000_000;
const SCOPE = SYNTHETIC_SCOPES[0]!;
const QUOTE_ID = '60000000-0000-4000-8000-000000000001';
const ORDER_ID = '61000000-0000-4000-8000-000000000001';
const LINE_ID = '62000000-0000-4000-8000-000000000001';

const CONTEXT = {
  principalKind: 'member',
  userSubject: SCOPE.expectedSubject,
  membershipId: '30000000-0000-4000-8000-000000000001',
  organisationId: SCOPE.organisationId,
  organisationKind: 'pharmacy',
  branchId: SCOPE.branchId,
  role: 'pharmacy_owner',
};

function makeApi() {
  return {
    getContext: vi.fn(async (): Promise<ApiResult> => ({ status: 200, body: CONTEXT })),
    getNeed: vi.fn(async (): Promise<ApiResult> => ({
      status: 200,
      body: { id: SYNTHETIC_NEED_ID, productRef: 'product-ref', quantity: '2', status: 'open', version: 1 },
    })),
    createQuote: vi.fn(async (): Promise<ApiResult> => ({
      status: 201,
      body: { id: QUOTE_ID, version: 1, total: '24.7', currency: 'EGP' },
    })),
    approveQuote: vi.fn(async (): Promise<ApiResult> => ({
      status: 202,
      body: { approvalId: 'a', orderIntentIds: [ORDER_ID] },
    })),
    getOrder: vi.fn(async (): Promise<ApiResult> => ({
      status: 200,
      body: { id: ORDER_ID, state: 'queued', lines: [], uncertainty: null },
    })),
    confirmReceipt: vi.fn(async (): Promise<ApiResult> => ({ status: 200, body: { id: 'receipt-1' } })),
  };
}

function makeOidc() {
  return {
    createAuthorizationRequest: vi.fn(async () => ({
      url: 'http://127.0.0.1:55433/auth?state=state-value&client_id=pharmacart-web-local',
      state: 'state-value',
      codeVerifier: 'verifier-value',
    })),
    exchangeAuthorizationCode: vi.fn(async () => ({ accessToken: 'synthetic-access-token', expiresInSeconds: 300 })),
  };
}

type Harness = {
  router: BffRouter;
  sessions: SessionStore;
  api: ReturnType<typeof makeApi>;
  oidc: ReturnType<typeof makeOidc>;
  now: { value: number };
};

function harness(): Harness {
  const now = { value: START };
  const sessions = createInMemorySessionStore({ now: () => now.value, maxSessionSeconds: 300 });
  const api = makeApi();
  const oidc = makeOidc();
  const router = createBffRouter({ config: loadWebConfig({}), sessions, api: api as never, oidc: oidc as never });
  return { router, sessions, api, oidc, now };
}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

function get(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path: string, options: { cookie?: string; csrf?: string; body?: unknown; origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers['x-pharmacart-csrf'] = options.csrf;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

/** Drives login and scope selection so the later tests start from a usable session. */
async function signIn(h: Harness) {
  const begin = await h.router.beginLogin(get('/auth/login'));
  const pending = cookieValue(begin, 'pharmacart_web_login')!;
  const callback = await h.router.completeLogin(
    get('/auth/callback?code=the-code&state=state-value', `pharmacart_web_login=${pending}`),
  );
  const sessionId = cookieValue(callback, 'pharmacart_web_session')!;
  const cookie = `pharmacart_web_session=${sessionId}`;
  const csrf = h.sessions.get(sessionId)!.csrfToken;
  return { sessionId, cookie, csrf, begin, callback };
}

async function signedInWithScope(h: Harness) {
  const signedIn = await signIn(h);
  await h.router.selectScope(
    post('/api/bff/scope', {
      cookie: signedIn.cookie,
      csrf: signedIn.csrf,
      body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
    }),
  );
  return signedIn;
}

describe('BFF login', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('redirects to the local provider and keeps state and verifier in an HttpOnly cookie reference', async () => {
    const response = await h.router.beginLogin(get('/auth/login'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://127.0.0.1:55433/auth?state=state-value&client_id=pharmacart-web-local',
    );
    const setCookie = response.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('pharmacart_web_login=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('verifier-value');
    expect(setCookie).not.toContain('state-value');
  });

  it('creates no session until the callback completes', async () => {
    await h.router.beginLogin(get('/auth/login'));
    expect(h.sessions.size()).toBe(0);
  });

  it('completes the callback, sets an opaque session cookie and never exposes the token', async () => {
    const { callback, sessionId } = await signIn(h);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/purchase`);
    expect(sessionId.length).toBeGreaterThanOrEqual(32);
    expect(sessionId).not.toContain('synthetic-access-token');

    const headers = [...callback.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    expect(headers).not.toContain('synthetic-access-token');
    expect(await callback.text()).not.toContain('synthetic-access-token');
    expect(h.sessions.get(sessionId)?.accessToken).toBe('synthetic-access-token');
  });

  it('clears the single-use login cookie once the callback runs', async () => {
    const { callback } = await signIn(h);
    const cleared = callback.headers.getSetCookie().find((header) => header.startsWith('pharmacart_web_login='));
    expect(cleared).toContain('Max-Age=0');
  });

  it('refuses a replayed authorization code because the pending login is single use', async () => {
    const begin = await h.router.beginLogin(get('/auth/login'));
    const pending = cookieValue(begin, 'pharmacart_web_login')!;
    const cookie = `pharmacart_web_login=${pending}`;
    await h.router.completeLogin(get('/auth/callback?code=the-code&state=state-value', cookie));
    const replay = await h.router.completeLogin(get('/auth/callback?code=the-code&state=state-value', cookie));
    expect(replay.headers.get('location')).toContain('authError=LOGIN_STATE_MISSING');
    expect(h.sessions.size()).toBe(1);
  });

  it('refuses a callback whose state does not match the pending login', async () => {
    const begin = await h.router.beginLogin(get('/auth/login'));
    const pending = cookieValue(begin, 'pharmacart_web_login')!;
    const response = await h.router.completeLogin(
      get('/auth/callback?code=the-code&state=forged', `pharmacart_web_login=${pending}`),
    );
    expect(response.headers.get('location')).toContain('authError=LOGIN_STATE_MISMATCH');
    expect(h.oidc.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(h.sessions.size()).toBe(0);
  });

  it('refuses a callback with no pending login cookie at all', async () => {
    const response = await h.router.completeLogin(get('/auth/callback?code=the-code&state=state-value'));
    expect(response.headers.get('location')).toContain('authError=LOGIN_STATE_MISSING');
    expect(h.oidc.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(h.sessions.size()).toBe(0);
  });

  it('reports a provider error response without creating a session', async () => {
    const begin = await h.router.beginLogin(get('/auth/login'));
    const pending = cookieValue(begin, 'pharmacart_web_login')!;
    const response = await h.router.completeLogin(
      get('/auth/callback?error=access_denied&state=state-value', `pharmacart_web_login=${pending}`),
    );
    expect(response.headers.get('location')).toContain('authError=LOGIN_REFUSED');
    expect(h.sessions.size()).toBe(0);
  });

  it('reports an unreachable identity provider as a sign-in failure rather than a crash', async () => {
    h.oidc.createAuthorizationRequest.mockRejectedValue(new Error('ECONNREFUSED'));
    const response = await h.router.beginLogin(get('/auth/login'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('authError=LOGIN_PROVIDER_UNAVAILABLE');
    expect(response.headers.getSetCookie().join('\n')).not.toContain('pharmacart_web_login=p');
  });

  it('binds the session lifetime to the access token expiry', async () => {
    h.oidc.exchangeAuthorizationCode.mockResolvedValue({ accessToken: 'short', expiresInSeconds: 60 });
    const { sessionId } = await signIn(h);
    expect(h.sessions.get(sessionId)!.expiresAt).toBe(START + 60_000);
  });
});

describe('BFF session and scope', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('answers 401 for an anonymous session read', async () => {
    const response = await h.router.readSession(get('/api/bff/session'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('returns a session view without the access token', async () => {
    const { cookie } = await signIn(h);
    const response = await h.router.readSession(get('/api/bff/session', cookie));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('synthetic-access-token');
    expect(JSON.parse(text).session).toMatchObject({ scope: null });
  });

  it('refuses scope selection from a foreign origin before touching the API', async () => {
    const { cookie, csrf } = await signIn(h);
    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        cookie,
        csrf,
        origin: 'http://evil.example.com',
        body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FOREIGN_ORIGIN' } });
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('refuses a foreign origin before it even looks for a session', async () => {
    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        origin: 'http://evil.example.com',
        body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FOREIGN_ORIGIN' } });
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('refuses scope selection without the CSRF token', async () => {
    const { cookie } = await signIn(h);
    const response = await h.router.selectScope(
      post('/api/bff/scope', { cookie, body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId } }),
    );
    expect(response.status).toBe(403);
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('refuses a scope pair that is not a known synthetic fixture', async () => {
    const { cookie, csrf } = await signIn(h);
    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        cookie,
        csrf,
        body: { organisationId: SCOPE.organisationId, branchId: '00000000-0000-4000-8000-000000000000' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'UNKNOWN_SCOPE' } });
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('confirms the scope against the real API and records the verified subject', async () => {
    const { cookie, csrf, sessionId } = await signIn(h);
    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        cookie,
        csrf,
        body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
      }),
    );
    expect(response.status).toBe(200);
    expect(h.api.getContext).toHaveBeenCalledWith({
      accessToken: 'synthetic-access-token',
      organisationId: SCOPE.organisationId,
      branchId: SCOPE.branchId,
    });
    expect(h.sessions.get(sessionId)!.scope).toMatchObject({ role: 'pharmacy_owner' });
    expect((await response.json()).session.subject).toBe(SCOPE.expectedSubject);
  });

  it('passes an API membership refusal through and leaves the scope unset', async () => {
    h.api.getContext.mockResolvedValue({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'no', correlationId: 'c' } } });
    const { cookie, csrf, sessionId } = await signIn(h);
    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        cookie,
        csrf,
        body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
      }),
    );
    expect(response.status).toBe(403);
    expect(h.sessions.get(sessionId)!.scope).toBeNull();
  });

  it('logs out only on a guarded request and destroys the session', async () => {
    const { cookie, csrf, sessionId } = await signIn(h);
    expect((await h.router.logout(post('/api/bff/logout', { cookie }))).status).toBe(403);
    expect(h.sessions.get(sessionId)).not.toBeNull();

    const response = await h.router.logout(post('/api/bff/logout', { cookie, csrf }));
    expect(response.status).toBe(204);
    expect(h.sessions.get(sessionId)).toBeNull();
    expect(response.headers.getSetCookie().join('\n')).toContain('Max-Age=0');
  });

  it('treats an expired session as unauthenticated on the next call', async () => {
    const { cookie } = await signedInWithScope(h);
    h.now.value = START + 300_000;
    const response = await h.router.readNeed(get(`/api/bff/needs/${SYNTHETIC_NEED_ID}`, cookie), SYNTHETIC_NEED_ID);
    expect(response.status).toBe(401);
    expect(h.api.getNeed).not.toHaveBeenCalled();
  });
});

describe('BFF purchase loop', () => {
  let h: Harness;
  let cookie: string;
  let csrf: string;
  let sessionId: string;

  beforeEach(async () => {
    h = harness();
    ({ cookie, csrf, sessionId } = await signedInWithScope(h));
  });

  it('requires a chosen scope before reading a need', async () => {
    const fresh = harness();
    const anon = await signIn(fresh);
    const response = await fresh.router.readNeed(
      get(`/api/bff/needs/${SYNTHETIC_NEED_ID}`, anon.cookie),
      SYNTHETIC_NEED_ID,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'SCOPE_REQUIRED' } });
    expect(fresh.api.getNeed).not.toHaveBeenCalled();
  });

  it('refuses a need identifier that is not a canonical UUID', async () => {
    const response = await h.router.readNeed(get('/api/bff/needs/nope', cookie), 'nope');
    expect(response.status).toBe(400);
    expect(h.api.getNeed).not.toHaveBeenCalled();
  });

  it('returns the need with its pack reference, quantity and version', async () => {
    const response = await h.router.readNeed(get(`/api/bff/needs/${SYNTHETIC_NEED_ID}`, cookie), SYNTHETIC_NEED_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ productRef: 'product-ref', quantity: '2', version: 1 });
  });

  it('passes a 404 for an unknown need straight through', async () => {
    h.api.getNeed.mockResolvedValue({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x', correlationId: 'c' } } });
    const response = await h.router.readNeed(get(`/api/bff/needs/${SYNTHETIC_NEED_ID}`, cookie), SYNTHETIC_NEED_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('builds a box-only cash quote command from the allowlisted supplier selection', async () => {
    const supplier = SYNTHETIC_SUPPLIERS.find((option) => option.supplierId !== null)!;
    await h.router.requestQuote(
      post('/api/bff/quotes', {
        cookie,
        csrf,
        body: { needId: SYNTHETIC_NEED_ID, needVersion: 1, quantity: '2', supplierKey: supplier.key },
      }),
    );
    expect(h.api.createQuote).toHaveBeenCalledTimes(1);
    const [, command] = h.api.createQuote.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(command).toEqual({
      branchId: SCOPE.branchId,
      lines: [{ needId: SYNTHETIC_NEED_ID, needVersion: 1, quantity: '2', unit: 'box' }],
      constraints: { supplierIds: [supplier.supplierId], paymentTerm: 'cash' },
    });
  });

  it('refuses a supplier selection outside the synthetic allowlist', async () => {
    const response = await h.router.requestQuote(
      post('/api/bff/quotes', {
        cookie,
        csrf,
        body: {
          needId: SYNTHETIC_NEED_ID,
          needVersion: 1,
          quantity: '2',
          supplierKey: '../../10000000-0000-4000-8000-000000000099',
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'UNKNOWN_SUPPLIER' } });
    expect(h.api.createQuote).not.toHaveBeenCalled();
  });

  it('refuses a quantity that is not a canonical positive decimal', async () => {
    for (const quantity of ['0', '-1', '1.', 'abc', '']) {
      const response = await h.router.requestQuote(
        post('/api/bff/quotes', {
          cookie,
          csrf,
          body: { needId: SYNTHETIC_NEED_ID, needVersion: 1, quantity, supplierKey: SYNTHETIC_SUPPLIERS[0]!.key },
        }),
      );
      expect(response.status, `quantity ${quantity}`).toBe(400);
    }
    expect(h.api.createQuote).not.toHaveBeenCalled();
  });

  it('refuses an unguarded quote request', async () => {
    const response = await h.router.requestQuote(
      post('/api/bff/quotes', {
        cookie,
        origin: null,
        body: { needId: SYNTHETIC_NEED_ID, needVersion: 1, quantity: '2', supplierKey: SYNTHETIC_SUPPLIERS[0]!.key },
      }),
    );
    expect(response.status).toBe(403);
    expect(h.api.createQuote).not.toHaveBeenCalled();
  });

  it('keeps the same idempotency key when an approval is retried after a network failure', async () => {
    h.api.approveQuote.mockRejectedValueOnce(new Error('socket hang up'));
    const body = { quoteVersion: 1 };

    const failed = await h.router.approveQuote(post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, csrf, body }), QUOTE_ID);
    expect(failed.status).toBe(502);

    const retried = await h.router.approveQuote(post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, csrf, body }), QUOTE_ID);
    expect(retried.status).toBe(202);

    const keys = h.api.approveQuote.mock.calls.map((call) => (call as unknown as string[])[3]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('uses a new idempotency key after a re-quote so a fresh approval is a distinct command', async () => {
    await h.router.approveQuote(post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, csrf, body: { quoteVersion: 1 } }), QUOTE_ID);
    const other = '60000000-0000-4000-8000-000000000002';
    await h.router.approveQuote(post(`/api/bff/quotes/${other}/approve`, { cookie, csrf, body: { quoteVersion: 1 } }), other);

    const keys = h.api.approveQuote.mock.calls.map((call) => (call as unknown as string[])[3]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('never approves without an explicit guarded request', async () => {
    const response = await h.router.approveQuote(
      post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, origin: null, body: { quoteVersion: 1 } }),
      QUOTE_ID,
    );
    expect(response.status).toBe(403);
    expect(h.api.approveQuote).not.toHaveBeenCalled();
  });

  it('refuses an approval whose quote version is not a positive integer', async () => {
    for (const quoteVersion of [0, -1, 1.5, '1', null]) {
      const response = await h.router.approveQuote(
        post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, csrf, body: { quoteVersion } }),
        QUOTE_ID,
      );
      expect(response.status, `version ${String(quoteVersion)}`).toBe(400);
    }
    expect(h.api.approveQuote).not.toHaveBeenCalled();
  });

  it('surfaces a stale quote refusal so the operator must request a new quote', async () => {
    h.api.approveQuote.mockResolvedValue({
      status: 409,
      body: { error: { code: 'REQUOTE_REQUIRED', message: 'stale', correlationId: 'c' } },
    });
    const response = await h.router.approveQuote(
      post(`/api/bff/quotes/${QUOTE_ID}/approve`, { cookie, csrf, body: { quoteVersion: 1 } }),
      QUOTE_ID,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'REQUOTE_REQUIRED' } });
  });

  it('returns the order intent state and uncertainty exactly as the API reported it', async () => {
    h.api.getOrder.mockResolvedValue({
      status: 200,
      body: { id: ORDER_ID, state: 'outcome_unknown', uncertainty: { safeToRetry: false, nextAction: 'reconciliation_required' }, lines: [] },
    });
    const response = await h.router.readOrder(get(`/api/bff/orders/${ORDER_ID}`, cookie), ORDER_ID);
    expect(await response.json()).toMatchObject({
      state: 'outcome_unknown',
      uncertainty: { safeToRetry: false, nextAction: 'reconciliation_required' },
    });
  });

  it('confirms a receipt with a server-held reference that is stable across a retry', async () => {
    const body = { lines: [{ lineId: LINE_ID, quantity: '1' }] };
    h.api.confirmReceipt.mockRejectedValueOnce(new Error('socket hang up'));

    const failed = await h.router.confirmReceipt(post(`/api/bff/orders/${ORDER_ID}/receipts`, { cookie, csrf, body }), ORDER_ID);
    expect(failed.status).toBe(502);
    const retried = await h.router.confirmReceipt(post(`/api/bff/orders/${ORDER_ID}/receipts`, { cookie, csrf, body }), ORDER_ID);
    expect(retried.status).toBe(200);

    const commands = h.api.confirmReceipt.mock.calls.map((call) => (call as unknown as [unknown, unknown, { reference: string }])[2]);
    expect(commands[0]!.reference).toBe(commands[1]!.reference);
    expect((await retried.json()).reference).toBe(commands[0]!.reference);
  });

  it('uses a different receipt reference for a different set of received quantities', async () => {
    await h.router.confirmReceipt(
      post(`/api/bff/orders/${ORDER_ID}/receipts`, { cookie, csrf, body: { lines: [{ lineId: LINE_ID, quantity: '1' }] } }),
      ORDER_ID,
    );
    await h.router.confirmReceipt(
      post(`/api/bff/orders/${ORDER_ID}/receipts`, { cookie, csrf, body: { lines: [{ lineId: LINE_ID, quantity: '2' }] } }),
      ORDER_ID,
    );
    const references = h.api.confirmReceipt.mock.calls.map((call) => (call as unknown as [unknown, unknown, { reference: string }])[2].reference);
    expect(references[0]).not.toBe(references[1]);
  });

  it('refuses a receipt with no lines or a non-decimal quantity', async () => {
    for (const lines of [[], [{ lineId: LINE_ID, quantity: '0' }], [{ lineId: 'x', quantity: '1' }]]) {
      const response = await h.router.confirmReceipt(
        post(`/api/bff/orders/${ORDER_ID}/receipts`, { cookie, csrf, body: { lines } }),
        ORDER_ID,
      );
      expect(response.status).toBe(400);
    }
    expect(h.api.confirmReceipt).not.toHaveBeenCalled();
  });

  it('refuses a malformed or oversized request body', async () => {
    const malformed = new Request(`${ORIGIN}/api/bff/quotes`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-pharmacart-csrf': csrf, cookie, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect((await h.router.requestQuote(malformed)).status).toBe(400);

    const oversized = post('/api/bff/quotes', {
      cookie,
      csrf,
      body: { needId: SYNTHETIC_NEED_ID, needVersion: 1, quantity: '2', supplierKey: 'x'.repeat(20_000) },
    });
    expect((await h.router.requestQuote(oversized)).status).toBe(413);
    expect(h.api.createQuote).not.toHaveBeenCalled();
  });

  it('never reveals the access token in any purchase-loop response', async () => {
    const responses = await Promise.all([
      h.router.readSession(get('/api/bff/session', cookie)),
      h.router.readNeed(get(`/api/bff/needs/${SYNTHETIC_NEED_ID}`, cookie), SYNTHETIC_NEED_ID),
      h.router.readOrder(get(`/api/bff/orders/${ORDER_ID}`, cookie), ORDER_ID),
    ]);
    for (const response of responses) {
      expect(await response.text()).not.toContain('synthetic-access-token');
    }
    expect(h.sessions.get(sessionId)!.accessToken).toBe('synthetic-access-token');
  });
});

/**
 * The 8 KiB bound has to hold against the body that was actually sent, not against the convenient
 * measure of it. Reading the whole body first and only then measuring its UTF-16 length means a
 * multi-megabyte POST is buffered in full before the 413, and that a multi-byte body of the same
 * declared length is several times larger than the bound allows.
 */
describe('BFF request body bounds', () => {
  let h: Harness;
  let session: { cookie: string; csrf: string };

  beforeEach(async () => {
    h = harness();
    const signedIn = await signedInWithScope(h);
    session = { cookie: signedIn.cookie, csrf: signedIn.csrf };
    h.api.getContext.mockClear();
  });

  function rawPost(body: BodyInit, extraHeaders: Record<string, string> = {}): Request {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: session.cookie,
        'x-pharmacart-csrf': session.csrf,
        ...extraHeaders,
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as unknown as RequestInit;
    return new Request(`${ORIGIN}/api/bff/scope`, init);
  }

  it('refuses a declared oversized body without reading it at all', async () => {
    const response = await h.router.selectScope(
      rawPost(JSON.stringify({ organisationId: SCOPE.organisationId, branchId: SCOPE.branchId }), {
        'content-length': String(MAX_BFF_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('measures the body in bytes rather than UTF-16 code units', async () => {
    // 3000 astral characters are 6000 UTF-16 code units but 12000 UTF-8 bytes, so this body is under
    // the bound by the old measure and well over it by the one that matters.
    const body = JSON.stringify({ organisationId: '\u{1F600}'.repeat(3000), branchId: SCOPE.branchId });
    expect(body.length).toBeLessThan(MAX_BFF_BODY_BYTES);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_BFF_BODY_BYTES);

    const response = await h.router.selectScope(rawPost(body));
    expect(response.status).toBe(413);
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('abandons an oversized streamed body instead of buffering the whole of it', async () => {
    const chunk = new Uint8Array(4096).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.slice());
      },
    });

    const response = await h.router.selectScope(rawPost(stream));
    expect(response.status).toBe(413);
    // The bound is passed inside the first three 4 KiB chunks; reading the body whole pulled all 64.
    expect(pulled).toBeLessThanOrEqual(8);
    expect(h.api.getContext).not.toHaveBeenCalled();
  });

  it('still accepts a body that is comfortably inside the bound', async () => {
    const response = await h.router.selectScope(
      rawPost(JSON.stringify({ organisationId: SCOPE.organisationId, branchId: SCOPE.branchId })),
    );
    expect(response.status).toBe(200);
    expect(h.api.getContext).toHaveBeenCalledTimes(1);
  });
});

describe('reported identity', () => {
  it('never invents a signed-in subject from the fixture list', async () => {
    const h = harness();
    // A context response that carries no userSubject: the only honest answer is that this app does
    // not know the subject, not the one the seed script happens to pair with the chosen scope.
    h.api.getContext.mockResolvedValue({
      status: 200,
      body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId, organisationKind: 'pharmacy', role: 'purchaser' },
    });
    const { cookie, csrf, sessionId } = await signIn(h);

    const response = await h.router.selectScope(
      post('/api/bff/scope', {
        cookie,
        csrf,
        body: { organisationId: SCOPE.organisationId, branchId: SCOPE.branchId },
      }),
    );
    expect(response.status).toBe(200);

    const payload = await response.text();
    expect(payload).not.toContain(SCOPE.expectedSubject);
    expect(JSON.parse(payload).session.subject).toBeNull();
    expect(h.sessions.get(sessionId)!.subject).toBeNull();
  });
});
