import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { FakeSupplier } from '../../supplier/src/fake.ts';
import { IntentWorker, confirmReceipt } from '../src/orders.ts';
import { ids, sql, resetDatabase } from './support.ts';
import { seedProcurement } from './procurement-fixture.ts';
import { createQuote, approveQuote } from '../src/procurement.ts';
import { withTransaction, createRuntimePool } from '../src/runtime.ts';
import { configureRuntimeLogin } from '../scripts/runtime-setup.mjs';
import { localIdentity } from '../../auth/test/local-identity.ts';
import { createAccessTokenVerifier } from '../../auth/src/verify-access-token.ts';
import { buildTenantApi } from '../../../apps/api/src/tenant-api.ts';

test('AC-006/009/010/014: timeout lookup, partial quantities, duplicate receipt and actual restore stay safe', async (t) => {
  let pool=await resetDatabase();
  const directory=await mkdtemp(join(process.cwd(),'tmp-supplier-'));
  const supplier=new FakeSupplier(join(directory,'ledger.json'),'timeout_after_accept');
  const scope={subject:'synthetic:user:a',organisationId:ids.a,branchId:ids.branchA};
  const transaction=<T>(callback: Parameters<typeof withTransaction<T>>[4])=>withTransaction(pool,scope.subject,scope.organisationId,scope.branchId,callback);
  // Restore can exceed 30 seconds on Windows while the full serial database gate is under load.
  // Keep the operation bounded, but leave enough headroom for Docker Desktop to flush the database.
  const docker=(args:string[])=>execFileSync('docker',['compose','-p','pharmacart','-f','infra/compose.yaml','exec','-T','postgres',...args],{windowsHide:true,stdio:'pipe',timeout:120000});
  try {
    await seedProcurement();
    const quote=await transaction((c,x)=>createQuote(c,x,{branchId:ids.branchA,lines:[{needId:ids.needA,needVersion:1,quantity:'2',unit:'box'}],constraints:{supplierIds:[],paymentTerm:'cash'}}));
    const approval=await transaction((c,x)=>approveQuote(c,x,quote.id,1,'supplier-test'));
    const intentId=approval.body.orderIntentIds[0]!;
    const identity=await localIdentity();
    const app=buildTenantApi(pool,createAccessTokenVerifier({issuer:identity.issuer,jwksUri:`${identity.issuer}/jwks`,audience:'pharmacart-api'}));
    t.after(async()=>{await app.close();await identity.close();});
    const {access_token:token}=await identity.token();
    const headers={authorization:`Bearer ${token}`,'x-organisation-id':ids.a,'x-branch-id':ids.branchA};
    docker(['pg_dump','-U','pharmacart_bootstrap','-d','pharmacart_test','-Fc','-f','/tmp/pharmacart-ac014.dump']);
    const worker=new IntentWorker(pool,scope,supplier);
    assert.equal((await worker.run(intentId)).state,'paused');
    const lookup=supplier.lookup.bind(supplier);
    supplier.lookup=async()=>{throw new Error('Synthetic lookup unavailable');};
    const blocked=new IntentWorker(pool,scope,supplier);
    await blocked.enableSyntheticDispatch();
    assert.equal((await blocked.run(intentId)).state,'outcome_unknown');
    assert.equal((await supplier.ledger()).submitCalls,0);
    supplier.lookup=lookup;
    await worker.enableSyntheticDispatch();
    assert.equal((await worker.run(intentId)).state,'outcome_unknown');
    const unknown=await app.inject({url:`/v1/orders/${intentId}`,headers});
    assert.equal(unknown.json().uncertainty.safeToRetry,false);
    assert.equal((await sql('SELECT reserved_amount=24.7 FROM budget')).trim(),'t');
    assert.equal((await worker.run(intentId)).state,'acknowledged');
    assert.equal((await supplier.ledger()).submitCalls,1);
    assert.equal((await sql('SELECT accepted::text || \'|\' || rejected FROM order_line')).trim(),'1|1');
    const lineId=(await sql('SELECT id FROM order_line')).trim();
    const view=await app.inject({url:`/v1/orders/${intentId}`,headers});
    assert.equal(view.json().lines[0].accepted,'1');assert.equal(view.json().lines[0].rejected,'1');
    const receipt=async()=>{
      const response=await app.inject({method:'POST',url:`/v1/orders/${intentId}/receipts`,headers,payload:{reference:'receipt-stable',lines:[{lineId,quantity:'1'}]}});
      assert.equal(response.statusCode,200,response.body);return response.json();
    };
    const receipts=await Promise.all([receipt(),receipt()]);
    assert.equal(receipts[0]!.id,receipts[1]!.id);
    assert.equal((await sql('SELECT count(*) FROM receipt')).trim(),'1');
    assert.equal((await sql('SELECT count(*) FROM receipt_writeback')).trim(),'1');
    assert.equal((await sql('SELECT received FROM order_line')).trim(),'1');
    await assert.rejects(transaction((c,x)=>confirmReceipt(c,x,intentId,'receipt-stable',[{lineId,quantity:'2'}])),/IDEMPOTENCY_KEY_REUSED/);
    assert.equal((await sql('SELECT spent_amount=12.35 AND reserved_amount=0 FROM budget')).trim(),'t');
    await pool.end();
    docker(['pg_restore','-U','pharmacart_bootstrap','-d','pharmacart_test','--clean','--if-exists','--exit-on-error','/tmp/pharmacart-ac014.dump']);
    pool=await createRuntimePool(await configureRuntimeLogin());
    const restored=new IntentWorker(pool,scope,supplier);
    assert.equal((await restored.run(intentId)).state,'paused');
    assert.equal((await restored.reconcile(intentId)).state,'acknowledged');
    assert.equal((await supplier.ledger()).submitCalls,1);
    assert.equal((await sql('SELECT state FROM order_intent')).trim(),'acknowledged');
  } finally {
    // Restore/reconnect may fail after the original pool was closed. Preserve that
    // failure instead of replacing it with a second pool.end() rejection.
    if (!pool.ending) await pool.end();
  }
});
