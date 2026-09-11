import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuote } from '../src/procurement.ts';
import { ids, sql, resetDatabase } from './support.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { decideCommercialPackMapping } from '../../domain/src/commercial-pack-mapping.ts';

import { seedProcurement } from './procurement-fixture.ts';

test('AC-002/005/007/008: binding quotes, parallel approval, changed keys, price freshness and mapping guard', async () => {
  assert.equal(typeof createQuote,'function');
  const pool=await resetDatabase(); const identity=await localIdentity();
  const app=buildTenantApi(pool,createAccessTokenVerifier({issuer:identity.issuer,jwksUri:`${identity.issuer}/jwks`,audience:'pharmacart-api'}));
  try {
    await seedProcurement(); const {access_token:token}=await identity.token();
    const headers={authorization:`Bearer ${token}`,'x-organisation-id':ids.a,'x-branch-id':ids.branchA};
    const payload={branchId:ids.branchA,lines:[{needId:ids.needA,needVersion:1,quantity:'2',unit:'box'}],constraints:{supplierIds:[],paymentTerm:'cash'}};
    const quote=await app.inject({method:'POST',url:'/v1/quotes',headers,payload});
    assert.equal(quote.statusCode,201,quote.body); assert.equal(quote.json().total,'24.7');
    const id=quote.json().id;
    const competing=await app.inject({method:'POST',url:'/v1/quotes',headers,payload});
    assert.equal(competing.statusCode,201);
    const approve=(key:string,quoteVersion=1)=>app.inject({method:'POST',url:`/v1/quotes/${id}/approve`,headers:{...headers,'idempotency-key':key},payload:{quoteVersion}});
    const replies=await Promise.all([approve('parallel-a'),approve('parallel-b'),approve('parallel-a')]);
    assert(replies.every(r=>[200,202].includes(r.statusCode)),replies.map(r=>r.body).join('\n'));
    assert(replies.every(r=>r.json().approvalId===replies[0]!.json().approvalId));
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
    assert.equal((await sql('SELECT count(*) FROM budget_reservation')).trim(),'1');
    assert.equal((await sql('SELECT count(*) FROM order_intent')).trim(),'1');
    assert.equal((await sql('SELECT reserved_amount=24.7 FROM budget')).trim(),'t');
    assert.equal((await approve('parallel-a',2)).statusCode,409);
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
    const competingApproval=await app.inject({method:'POST',url:`/v1/quotes/${competing.json().id}/approve`,headers:{...headers,'idempotency-key':'same-need'},payload:{quoteVersion:1}});
    assert.equal(competingApproval.statusCode,409);
    // A separate open need tests offer staleness without reusing an already approved need.
    await sql(`UPDATE need SET status='open',version=2 WHERE id='${ids.needA}'`);
    const second=await app.inject({method:'POST',url:'/v1/quotes',headers,payload:{...payload,lines:[{...payload.lines[0],needVersion:2}]}});
    assert.equal(second.statusCode,201,second.body);
    await sql('UPDATE account_offer SET unit_price=13,version=2');
    const stale=await app.inject({method:'POST',url:`/v1/quotes/${second.json().id}/approve`,headers:{...headers,'idempotency-key':'stale'},payload:{quoteVersion:1}});
    assert.equal(stale.statusCode,409); assert.equal(stale.json().error.code,'REQUOTE_REQUIRED');
    const catalogue=JSON.parse((await sql('SELECT json_agg(p) FROM (SELECT id,identity FROM procurement_product ORDER BY id) p')).trim()) as {id:string;identity:Record<string,unknown>}[];
    const mapping=decideCommercialPackMapping({identifiers:[],brand:'SYN Brand',manufacturer:undefined,strength:undefined,dosageForm:undefined,packSize:undefined,saleUnit:undefined},
      catalogue.map(p=>({id:p.id,brand:String(p.identity.brand),manufacturer:String(p.identity.manufacturer),strength:String(p.identity.strength),dosageForm:'tablet',packSize:{value:'20',unit:'tablet'},saleUnit:'box',identityStatus:'verified',verifiedIdentifiers:[]})));
    assert.equal(mapping.kind,'review');
    await sql("UPDATE source_product_map SET status='review',version=2");
    const ambiguous=await app.inject({method:'POST',url:'/v1/quotes',headers,payload:{...payload,lines:[{...payload.lines[0],needVersion:2}]}});
    assert.equal(ambiguous.statusCode,422); assert.equal(ambiguous.json().error.code,'MAPPING_UNVERIFIED');
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
  } finally {await app.close();await pool.end();await identity.close();}
});
