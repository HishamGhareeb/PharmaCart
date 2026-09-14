import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { MembershipAccessDeniedError, withTransaction, type RuntimeClient, type TenantContext } from '../../../packages/db/src/runtime.ts';
import { buildApp } from './app.ts';
import { ApiError } from './errors.ts';
import { registerListRoutes } from './list-routes.ts';
import { registerMappingRoutes } from './mapping-routes.ts';
import { authenticate, selector, type TokenVerifier } from './request-auth.ts';
import { ingestInventory, InventoryError, type InventoryCommand } from '../../../packages/db/src/inventory.ts';
import { inventoryCommandSchema } from '../../../packages/contracts/src/inventory-schema.ts';
import { quoteCommandSchema } from '../../../packages/contracts/src/quote-schema.ts';
import { createQuote, approveQuote, ProcurementError, type QuoteCommand } from '../../../packages/db/src/procurement.ts';
import { confirmReceipt } from '../../../packages/db/src/orders.ts';
import { approvalCommandSchema, receiptCommandSchema } from '../../../packages/contracts/scripts/openapi.ts';

// Re-exported so existing importers of the tenant API keep one entry point.
export { authenticate, selector, type TokenVerifier } from './request-auth.ts';
export function buildTenantApi(pool: Pool, verifier: TokenVerifier) {
  const app = buildApp();
  async function member<T>(request: FastifyRequest, operation: (client: RuntimeClient, context: TenantContext) => Promise<T>) {
    const identity = await authenticate(request, verifier);
    try {
      return await withTransaction(pool, identity.subject, selector(request.headers['x-organisation-id']),
        selector(request.headers['x-branch-id']), operation);
    } catch (error) {
      if (error instanceof MembershipAccessDeniedError) throw new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
      if (error instanceof ProcurementError) throw new ApiError(error.status,error.code,'The purchase request could not be completed.');
      throw error;
    }
  }
  app.get('/v1/context', request => member(request, async (_client, context) => context));
  app.get<{Params:{id:string}}>('/v1/orders/:id',request=>member(request,async client=>{
    const row=(await client.query('SELECT id,state,external_client_ref AS "externalClientRef",external_order_id AS "externalOrderId",version FROM order_intent WHERE id=$1',[selector(request.params.id)])).rows[0];
    if(!row)throw new ApiError(404,'NOT_FOUND','The requested resource was not found.');
    const lines=(await client.query('SELECT id,product_snapshot AS "productIdentity",ordered::text,accepted::text,rejected::text,shipped::text,received::text FROM order_line WHERE intent_id=$1 ORDER BY id',[row.id])).rows;
    return {...row,lines,uncertainty:['submitting','outcome_unknown','human_review'].includes(row.state)?{safeToRetry:false,nextAction:'reconciliation_required'}:null};
  }));
  app.post<{Params:{id:string};Body:{reference:string;lines:{lineId:string;quantity:string}[]}}>('/v1/orders/:id/receipts',{schema:{body:receiptCommandSchema}},request=>member(request,(client,context)=>confirmReceipt(client,context,selector(request.params.id),request.body.reference,request.body.lines)));
  app.post<{Body:QuoteCommand}>('/v1/quotes',{schema:{body:quoteCommandSchema}},async(request,reply)=>
    reply.code(201).send(await member(request,(client,context)=>createQuote(client,context,request.body))));
  app.post<{Params:{id:string};Body:{quoteVersion:number}}>('/v1/quotes/:id/approve',{schema:{body:approvalCommandSchema}},async(request,reply)=>{
    const result=await member(request,(client,context)=>{
      const key=request.headers['idempotency-key'];
      if(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new ApiError(400,'INVALID_REQUEST','A valid idempotency key is required.');
      return approveQuote(client,context,selector(request.params.id),request.body.quoteVersion,key);
    });
    return reply.code(result.status).send(result.body);
  });
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
  // GET /v1/needs, GET /v1/orders, GET /v1/needs/:id/mapping-candidates and POST /v1/needs/:id/mapping.
  // Both modules resolve membership through the same authenticated tenant transaction as the routes above.
  registerListRoutes(app, pool, verifier);
  registerMappingRoutes(app, pool, verifier);
  return app;
}
