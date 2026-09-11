import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { createLocalOidcProvider, LOCAL_RESOURCE } from '../../../infra/oidc/provider.ts';

// Drives the provider's development login and consent over HTTP with synthetic users only.
export async function localIdentity() {
  let handler: RequestListener = (_req, res) => { res.writeHead(503).end(); };
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const issuer = `http://127.0.0.1:${address.port}`;
  const provider = await createLocalOidcProvider({ issuer });
  handler = provider.callback();
  return { issuer, provider,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    async token(subject = 'synthetic:user:a') {
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(16).toString('hex');
      const params = new URLSearchParams({ client_id: 'pharmacart-local', response_type: 'code',
        redirect_uri: `${LOCAL_RESOURCE}/auth/callback`, scope: 'openid pharmacart', resource: LOCAL_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
      const cookies = new Map<string, string>();
      async function request(url: string, body?: URLSearchParams) {
        assert.equal(new URL(url, issuer).origin, issuer);
        const response = await fetch(new URL(url, issuer), { redirect: 'manual',
          method: body ? 'POST' : 'GET', headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '),
            ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          ...(body ? { body: body.toString() } : {}) });
        for (const cookie of response.headers.getSetCookie()) {
          const [pair] = cookie.split(';'); const index = pair!.indexOf('=');
          cookies.set(pair!.slice(0,index), pair!.slice(index+1));
        }
        return response;
      }
      let response = await request(`${issuer}/auth?${params}`);
      for (let step = 0; step < 12; step++) {
        const location = response.headers.get('location');
        if (location?.startsWith(`${LOCAL_RESOURCE}/auth/callback`)) {
          const callback = new URL(location);
          assert.equal(callback.searchParams.get('state'), state);
          assert(callback.searchParams.get('code'), location);
          const tokenResponse = await request('/token', new URLSearchParams({ grant_type: 'authorization_code',
            client_id: 'pharmacart-local', code: callback.searchParams.get('code')!, code_verifier: verifier,
            redirect_uri: `${LOCAL_RESOURCE}/auth/callback`, resource: LOCAL_RESOURCE }));
          assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
          const tokens = await tokenResponse.json() as { access_token: string; id_token: string };
          return tokens;
        }
        if (location) { response = await request(location); continue; }
        const html = await response.text();
        assert.equal(response.status, 200, html);
        const action = /action="([^"]+)"/.exec(html)?.[1];
        assert(action, html);
        const prompt = html.includes('name="login"') ? 'login' : 'consent';
        response = await request(action, new URLSearchParams({ prompt, login: subject }));
      }
      throw new Error('Local authorization flow did not complete');
    },
  };
}
