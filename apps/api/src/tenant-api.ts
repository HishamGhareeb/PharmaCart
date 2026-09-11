import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { VerifiedAccessToken } from '../../../packages/auth/src/verify-access-token.ts';
import { MembershipAccessDeniedError, withTransaction, type RuntimeClient, type TenantContext } from '../../../packages/db/src/runtime.ts';
import { buildApp } from './app.ts';
import { ApiError } from './errors.ts';
import { ingestInventory, InventoryError, type InventoryCommand } from '../../../packages/db/src/inventory.ts';
import { inventoryCommandSchema } from '../../../packages/contracts/src/inventory-schema.ts';

export type TokenVerifier = { verifyAccessToken(token: string): Promise<VerifiedAccessToken> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function selector(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400, 'INVALID_REQUEST', 'A canonical UUID selector is required.');
  return value;
}
export async function authenticate(request: FastifyRequest, verifier: TokenVerifier) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 16400) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  try { return await verifier.verifyAccessToken(header.slice(7)); }
  catch { throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.'); }
}
export function buildTenantApi(pool: Pool, verifier: TokenVerifier) {
  const app = buildApp();
  async function member<T>(request: FastifyRequest, operation: (client: RuntimeClient, context: TenantContext) => Promise<T>) {
    const identity = await authenticate(request, verifier);
    try {
      return await withTransaction(pool, identity.subject, selector(request.headers['x-organisation-id']),
        selector(request.headers['x-branch-id']), operation);
    } catch (error) {
      if (error instanceof MembershipAccessDeniedError) throw new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
      throw error;
    }
  }
  app.get('/v1/context', request => member(request, async (_client, context) => context));
  app.post<{Body:InventoryCommand}>('/v1/inventory',{schema:{body:inventoryCommandSchema}},async(request,reply)=>{
    const identity=await authenticate(request,verifier);
    try { return reply.code(202).send(await ingestInventory(pool,identity.subject,request.body)); }
    catch(error) {
      if(error instanceof InventoryError) throw new ApiError(error.code==='INSTALLATION_DENIED'?403:409,error.code,'Inventory event could not be accepted.');
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>('/v1/needs/:id', request => member(request, async client => {
    const result = await client.query(`SELECT id, product_ref AS "productRef", requested_quantity::text AS quantity, status, version FROM need WHERE id=$1`, [selector(request.params.id)]);
    if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
    return result.rows[0];
  }));
  return app;
}
