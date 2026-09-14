import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../src/lib/api-client.ts';

const AUTH = {
  accessToken: 'synthetic-access-token',
  organisationId: '10000000-0000-4000-8000-000000000001',
  branchId: '20000000-0000-4000-8000-000000000001',
};

function client(response: { status: number; body: unknown }) {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return { api: createApiClient({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: fetchImpl as never }), fetchImpl };
}

describe('server-side API client', () => {
  it('sends the bearer token and tenant scope headers and never forwards browser cookies', async () => {
    const { api, fetchImpl } = client({ status: 200, body: { organisationId: AUTH.organisationId } });
    await api.getContext(AUTH);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/v1/context');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-access-token');
    expect(headers.get('x-organisation-id')).toBe(AUTH.organisationId);
    expect(headers.get('x-branch-id')).toBe(AUTH.branchId);
    expect(headers.get('cookie')).toBeNull();
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('refuses a non-UUID identifier before any network call is made', async () => {
    const { api, fetchImpl } = client({ status: 200, body: {} });
    await expect(api.getNeed(AUTH, '../../v1/context')).rejects.toThrow(/uuid/i);
    await expect(api.getOrder(AUTH, 'http://evil.example.com')).rejects.toThrow(/uuid/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a scope that is not a canonical UUID pair', async () => {
    const { api, fetchImpl } = client({ status: 200, body: {} });
    await expect(api.getContext({ ...AUTH, organisationId: 'not-a-uuid' })).rejects.toThrow(/uuid/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('builds the need path from the validated identifier only', async () => {
    const { api, fetchImpl } = client({ status: 200, body: { id: '40000000-0000-4000-8000-000000000001' } });
    await api.getNeed(AUTH, '40000000-0000-4000-8000-000000000001');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0])
      .toBe('http://127.0.0.1:3000/v1/needs/40000000-0000-4000-8000-000000000001');
  });

  it('forwards the idempotency key on approval and the quote version body', async () => {
    const { api, fetchImpl } = client({ status: 202, body: { approvalId: 'x' } });
    await api.approveQuote(AUTH, '50000000-0000-4000-8000-000000000009', { quoteVersion: 1 }, 'stable-key-1');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/v1/quotes/50000000-0000-4000-8000-000000000009/approve');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('stable-key-1');
    expect(JSON.parse(String(init.body))).toEqual({ quoteVersion: 1 });
  });

  it('passes API refusals through unchanged instead of masking them', async () => {
    for (const status of [401, 403, 404, 409]) {
      const { api } = client({ status, body: { error: { code: 'X', message: 'm', correlationId: 'c' } } });
      const result = await api.getNeed(AUTH, '40000000-0000-4000-8000-000000000001');
      expect(result.status).toBe(status);
    }
  });

  it('reports a non-JSON API response as an upstream failure rather than crashing', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 502 }));
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: fetchImpl as never });
    const result = await api.getContext(AUTH);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('refuses a base URL that is not on the loopback allowlist', () => {
    expect(() => createApiClient({ baseUrl: 'https://api.example.com' })).toThrow();
  });
});
