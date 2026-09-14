import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { errors } from 'oidc-provider';

export const LOCAL_RESOURCE = 'http://127.0.0.1:3000';
export async function createLocalOidcProvider(options: { issuer?: string; environment?: string } = {}) {
  if ((options.environment ?? process.env.NODE_ENV) === 'production') throw new Error('Local OIDC is development only');
  const issuer = options.issuer ?? 'http://127.0.0.1:55433';
  const url = new URL(issuer);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Local issuer must be an HTTP loopback origin');
  }
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(privateKey), alg: 'RS256', kid: 'synthetic-local', use: 'sig' };
  return new Provider(issuer, {
    clients: [{ client_id: 'pharmacart-local', redirect_uris: ['http://127.0.0.1:3000/auth/callback'],
      response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' },
      // Separate public client for the local web app on port 3001. It shares no state with the client
      // above: a different client_id and its own single loopback redirect, still PKCE-only.
      { client_id: 'pharmacart-web-local', redirect_uris: ['http://127.0.0.1:3001/auth/callback'],
        response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
    jwks: { keys: [jwk] }, cookies: { keys: [randomBytes(32).toString('base64url')] },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: true },
      resourceIndicators: { enabled: true, defaultResource: () => LOCAL_RESOURCE,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== LOCAL_RESOURCE) throw new errors.InvalidTarget();
          return { scope: 'pharmacart', audience: 'pharmacart-api', accessTokenFormat: 'jwt',
            accessTokenTTL: 300, jwt: { sign: { alg: 'RS256' } } };
        } },
    },
    findAccount: (_ctx, subject) => {
      if (!['synthetic:user:a', 'synthetic:user:b', 'synthetic:connector:a'].includes(subject)) return undefined;
      return { accountId: subject, claims: () => ({ sub: subject }) };
    },
  });
}
