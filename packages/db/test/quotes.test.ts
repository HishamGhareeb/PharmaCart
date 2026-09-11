import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuote } from '../src/procurement.ts';
import { ids, sql, resetDatabase } from './support.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';

export async function seedProcurement() {
  await sql(`INSERT INTO procurement_product(id,identity,status) VALUES
    ('60000000-0000-4000-8000-000000000001','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"5 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','verified'),
    ('60000000-0000-4000-8000-000000000002','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"10 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','verified');
    INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES
    ('70000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','60000000-0000-4000-8000-000000000001','verified',1);
    UPDATE need SET source_map_id='70000000-0000-4000-8000-000000000001' WHERE id='${ids.needA}';
    INSERT INTO supplier_relationship(id,organisation_id,branch_id,supplier_id,status,terms_version) VALUES
    ('80000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','${ids.supplier}','active',1);
    INSERT INTO account_offer(id,organisation_id,branch_id,relationship_id,product_id,unit,unit_price,currency,version,terms_version,expires_at) VALUES
    ('90000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','80000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','box',12.35,'EGP',1,1,now()+interval '1 hour');
    INSERT INTO budget(organisation_id,branch_id,currency,period,limit_amount,reserved_amount) VALUES
    ('${ids.a}','${ids.branchA}','EGP',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),100,0);`);
}
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
    const approve=(key:string,quoteVersion=1)=>app.inject({method:'POST',url:`/v1/quotes/${id}/approve`,headers:{...headers,'idempotency-key':key},payload:{quoteVersion}});
    const replies=await Promise.all([approve('parallel-a'),approve('parallel-b'),approve('parallel-a')]);
    assert(replies.every(r=>[200,202].includes(r.statusCode)),replies.map(r=>r.body).join('\n'));
    assert(replies.every(r=>r.json().approvalId===replies[0]!.json().approvalId));
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
    assert.equal((await sql('SELECT count(*) FROM budget_reservation')).trim(),'1');
    assert.equal((await sql('SELECT count(*) FROM order_intent')).trim(),'1');
    assert.equal((await sql('SELECT reserved_amount::text FROM budget')).trim(),'24.70');
    assert.equal((await approve('parallel-a',2)).statusCode,409);
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
    // A separate open need tests offer staleness without reusing an already approved need.
    await sql(`UPDATE need SET status='open',version=2 WHERE id='${ids.needA}'`);
    const second=await app.inject({method:'POST',url:'/v1/quotes',headers,payload:{...payload,lines:[{...payload.lines[0],needVersion:2}]}});
    assert.equal(second.statusCode,201,second.body);
    await sql('UPDATE account_offer SET unit_price=13,version=2');
    const stale=await app.inject({method:'POST',url:`/v1/quotes/${second.json().id}/approve`,headers:{...headers,'idempotency-key':'stale'},payload:{quoteVersion:1}});
    assert.equal(stale.statusCode,409); assert.equal(stale.json().error.code,'REQUOTE_REQUIRED');
    await sql("UPDATE source_product_map SET status='review',version=2");
    const ambiguous=await app.inject({method:'POST',url:'/v1/quotes',headers,payload:{...payload,lines:[{...payload.lines[0],needVersion:2}]}});
    assert.equal(ambiguous.statusCode,422); assert.equal(ambiguous.json().error.code,'MAPPING_UNVERIFIED');
    assert.equal((await sql('SELECT count(*) FROM approval')).trim(),'1');
  } finally {await app.close();await pool.end();await identity.close();}
});
