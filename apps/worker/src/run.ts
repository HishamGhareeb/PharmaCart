import { resolve } from 'node:path';
import { createRuntimePool, withTransaction } from '../../../packages/db/src/runtime.ts';
import { IntentWorker } from '../../../packages/db/src/orders.ts';
import { FakeSupplier } from '../../../packages/supplier/src/fake.ts';

if(process.env.NODE_ENV==='production')throw new Error('This worker is synthetic development only');
const pool=await createRuntimePool();
const scope={subject:'synthetic:user:a',organisationId:'10000000-0000-4000-8000-000000000001',branchId:'20000000-0000-4000-8000-000000000001'};
const worker=new IntentWorker(pool,scope,new FakeSupplier(resolve('tmp/fake-supplier/ledger.json')));
try {
  const pending=await withTransaction(pool,scope.subject,scope.organisationId,scope.branchId,async c=>(await c.query("SELECT id FROM order_intent WHERE state IN ('queued','submitting','outcome_unknown') ORDER BY id")).rows);
  if(process.argv.includes('--submit'))await worker.enableSyntheticDispatch();
  for(const row of pending){
    const result=process.argv.includes('--submit')?await worker.run(row.id):await worker.reconcile(row.id);
    process.stdout.write(`${row.id} ${result.state}\n`);
  }
} finally {await pool.end();}
