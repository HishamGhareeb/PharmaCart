import { createApiClient } from './api-client.ts';
import { loadWebConfig, type WebConfig } from './config.ts';
import { createOidcClient } from './oidc.ts';
import { createBffRouter, type BffRouter } from './bff/router.ts';
import { createInMemorySessionStore, type SessionStore } from './session.ts';

/**
 * Lazy process-wide wiring.
 *
 * Construction is deliberately deferred until the first request so that importing a route module
 * during `next build` (which runs with NODE_ENV=production) does not trip the development-only
 * refusal. Sessions therefore live for as long as this dev server process does, and no longer.
 */

export type WebRuntime = { config: WebConfig; sessions: SessionStore; router: BffRouter };

let runtime: WebRuntime | null = null;

export function getWebRuntime(): WebRuntime {
  if (runtime) return runtime;
  const config = loadWebConfig();
  const sessions = createInMemorySessionStore({
    now: () => Date.now(),
    maxSessionSeconds: config.sessionMaxSeconds,
  });
  const api = createApiClient({ baseUrl: config.apiOrigin });
  const oidc = createOidcClient({
    issuer: config.oidcIssuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    resource: config.resource,
  });
  runtime = { config, sessions, router: createBffRouter({ config, sessions, api, oidc }) };
  return runtime;
}
