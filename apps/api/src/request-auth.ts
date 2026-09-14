import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { VerifiedAccessToken } from '../../../packages/auth/src/verify-access-token.ts';
import { withTransaction, type RuntimeClient, type TenantContext } from '../../../packages/db/src/runtime.ts';
import { ApiError } from './errors.ts';

/*
 * The request authority every tenant route shares: bearer verification, canonical tenant selectors and
 * the tenant transaction. It lives apart from tenant-api.ts so that the route modules buildTenantApi
 * registers can use it without importing tenant-api.ts back, which would close a runtime import cycle.
 */

export type TokenVerifier = { verifyAccessToken(token: string): Promise<VerifiedAccessToken> };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function selector(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400, 'INVALID_REQUEST', 'A canonical UUID selector is required.');
  return value;
}

export async function authenticate(request: FastifyRequest, verifier: TokenVerifier): Promise<VerifiedAccessToken> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 16400) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  try { return await verifier.verifyAccessToken(header.slice(7)); }
  catch { throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.'); }
}

/**
 * The seam between a route and a tenant transaction. Route modules accept one so their boundary can be
 * exercised without PostgreSQL; production always uses `poolScope`.
 */
export type TenantScope = <T>(
  request: FastifyRequest,
  operation: (client: RuntimeClient, context: TenantContext) => Promise<T>,
) => Promise<T>;

/**
 * Authenticates the bearer token, validates both tenant selectors and only then opens the tenant
 * transaction, so membership and branch authority are resolved by the database on every request and a
 * malformed request never takes a connection.
 */
export function poolScope(pool: Pool, verifier: TokenVerifier): TenantScope {
  return async <T>(
    request: FastifyRequest,
    operation: (client: RuntimeClient, context: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const identity = await authenticate(request, verifier);
    const organisationId = selector(request.headers['x-organisation-id']);
    const branchId = selector(request.headers['x-branch-id']);
    return withTransaction(pool, identity.subject, organisationId, branchId, operation);
  };
}
