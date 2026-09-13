import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FakeSupplier, type Acknowledgement } from '../../supplier/src/fake.ts';
import { withTransaction, type RuntimeClient, type TenantContext } from './runtime.ts';
import { ProcurementError, type QuoteLine } from './procurement.ts';
import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';

type WorkerScope={subject:string;organisationId:string;branchId:string};
type Intent={id:string;state:string;version:number;quote_id:string;supplier_id:string;external_client_ref:string;external_order_id:string|null};
async function intent(client:RuntimeClient,id:string):Promise<Intent>{
  const row=(await client.query('SELECT * FROM order_intent WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row)throw new ProcurementError(404,'NOT_FOUND');return row;
}
async function ensureLines(client:RuntimeClient,context:TenantContext,row:Intent){
  const quote=(await client.query('SELECT lines FROM quote WHERE id=$1',[row.quote_id])).rows[0];
  for(const line of (quote.lines as QuoteLine[]).filter(l=>l.supplierId===row.supplier_id)) {
    // Stable IDs survive a pre-send restore and remain distinct across intents for the same need.
    const hash=createHash('sha256').update(`${row.id}:${line.needId}`).digest('hex');
    const lineId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    await client.query('INSERT INTO order_line(id,organisation_id,branch_id,intent_id,need_id,product_snapshot,ordered) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(intent_id,need_id) DO NOTHING',
      [lineId,context.organisationId,context.branchId,row.id,line.needId,line.identity,line.quantity]);
  }
  return (await client.query('SELECT id AS "lineId",ordered::text AS quantity FROM order_line WHERE intent_id=$1 ORDER BY id',[row.id])).rows as {lineId:string;quantity:string}[];
}
async function releaseCompletedReservation(client:RuntimeClient,quoteId:string){
  const remaining=await client.query(`SELECT 1 FROM order_intent i LEFT JOIN order_line l ON l.intent_id=i.id WHERE i.quote_id=$1
    AND (i.state NOT IN ('acknowledged','rejected') OR l.received<>l.accepted OR l.accepted+l.rejected<>l.ordered) LIMIT 1`,[quoteId]);
  if(remaining.rowCount)return;
  const reservation=(await client.query("UPDATE budget_reservation SET status='released' WHERE quote_id=$1 AND status='reserved' RETURNING *",[quoteId])).rows[0];
  if(reservation){
    const spent=(await client.query(`SELECT coalesce(sum(round((ql->>'net')::numeric*l.accepted/l.ordered,2)),0)::text AS amount
      FROM order_line l JOIN order_intent i ON i.id=l.intent_id JOIN quote q ON q.id=i.quote_id,
      jsonb_array_elements(q.lines) ql WHERE q.id=$1 AND ql->>'needId'=l.need_id::text`,[quoteId])).rows[0].amount;
    await client.query('UPDATE budget SET reserved_amount=reserved_amount-$4::numeric,spent_amount=spent_amount+$6::numeric WHERE organisation_id=$1 AND branch_id=$2 AND period=$3 AND currency=$5',[reservation.organisation_id,reservation.branch_id,reservation.period,reservation.amount,reservation.currency,spent]);
  }
}
export class IntentWorker {
  private enabled=false;private checked=new Set<string>();
  readonly pool:Pool;readonly scope:WorkerScope;readonly supplier:FakeSupplier;
  constructor(pool:Pool,scope:WorkerScope,supplier:FakeSupplier){this.pool=pool;this.scope=scope;this.supplier=supplier;}
  private transaction<T>(callback:(c:RuntimeClient,x:TenantContext)=>Promise<T>){return withTransaction(this.pool,this.scope.subject,this.scope.organisationId,this.scope.branchId,callback);}
  async enableSyntheticDispatch(){
    const pending=await this.transaction(async c=>(await c.query("SELECT id FROM order_intent WHERE state IN ('queued','submitting','outcome_unknown')")).rows);
    for(const row of pending)await this.reconcile(row.id);
    this.enabled=true;
  }
  async run(id:string):Promise<{state:string}>{
    if(!this.enabled)return {state:'paused'};
    if(!this.checked.has(id)){
      const reconciled=await this.reconcile(id);
      if(!this.checked.has(id))return reconciled;
    }
    const claim=await this.transaction(async(c,x)=>{
      const row=await intent(c,id);
      if(row.state!=='queued')return {row,lines:undefined};
      const lines=await ensureLines(c,x,row);
      await c.query("UPDATE order_intent SET state='submitting',version=version+1 WHERE id=$1",[id]);
      await c.query("INSERT INTO submission_attempt(organisation_id,branch_id,intent_id,request_hash,outcome) VALUES($1,$2,$3,$4,'started')",[x.organisationId,x.branchId,id,createHash('sha256').update(JSON.stringify(lines)).digest('hex')]);
      await c.query("UPDATE procurement_outbox SET processed_at=now() WHERE aggregate_id=$1 AND event_type='OrderSubmissionRequested'",[id]);
      return {row,lines};
    });
    if(!claim.lines)return claim.row.state==='outcome_unknown'?this.reconcile(id):{state:claim.row.state};
    try {return await this.acknowledge(id,await this.supplier.submit(claim.row.external_client_ref,claim.lines));}
    catch {
      // A failed send is only this attempt's evidence. If a competing worker already settled the intent
      // from adapter evidence, report that durable outcome and record no unknown-outcome fact for it.
      return this.transaction(async(c,x)=>{
        const row=await intent(c,id);
        if(row.state!=='submitting')return {state:row.state};
        await c.query("UPDATE order_intent SET state='outcome_unknown',version=version+1 WHERE id=$1",[id]);
        await c.query("UPDATE submission_attempt SET outcome='unknown' WHERE intent_id=$1 AND outcome='started'",[id]);
        await c.query("INSERT INTO procurement_outbox(organisation_id,branch_id,aggregate_id,event_type) VALUES($1,$2,$3,'OrderOutcomeUnknown') ON CONFLICT DO NOTHING",[x.organisationId,x.branchId,id]);
        return {state:'outcome_unknown'};
      });
    }
  }
  async reconcile(id:string):Promise<{state:string}>{
    const observed=await this.transaction(c=>intent(c,id));
    if(['acknowledged','rejected'].includes(observed.state))return {state:observed.state};
    let found:Acknowledgement|undefined;
    // An unavailable or refused lookup is inconclusive: this attempt reports uncertainty and mutates nothing.
    try {found=await this.supplier.lookup(observed.external_client_ref);}catch{return {state:'outcome_unknown'};}
    if(found)return this.acknowledge(id,found);
    if(observed.state==='queued'){this.checked.add(id);return {state:'queued'};}
    // A not-found answer describes the supplier at lookup time, so it cannot settle a send that may still
    // be in flight. Only a finished attempt ('outcome_unknown') may be escalated, and only when nothing
    // moved since the state was observed; otherwise a competing worker owns the newer outcome.
    return this.transaction(async c=>{
      const current=await intent(c,id);
      if(current.state!=='outcome_unknown'||current.version!==observed.version)return {state:current.state};
      await c.query("UPDATE order_intent SET state='human_review',version=version+1 WHERE id=$1",[id]);
      return {state:'human_review'};
    });
  }
  private async acknowledge(id:string,ack:Acknowledgement){
    return this.transaction(async(c,x)=>{
      const row=await intent(c,id);
      if(row.state==='acknowledged')return {state:row.state};
      // One intent keeps one external order for its lifetime; a second identity means the ledger and the
      // durable record disagree and must not be merged automatically.
      if(row.external_order_id&&row.external_order_id!==ack.externalOrderId)throw new Error('Conflicting external order identity');
      const expected=await ensureLines(c,x,row);
      if(!ack.externalOrderId||ack.lines.length!==expected.length||new Set(ack.lines.map(l=>l.lineId)).size!==expected.length)throw new Error('Invalid acknowledgement');
      for(const line of ack.lines){
        if(!expected.some(l=>l.lineId===line.lineId))throw new Error('Unknown supplier line');
        await c.query('UPDATE order_line SET accepted=$2,rejected=$3,shipped=$4 WHERE id=$1 AND intent_id=$5',[line.lineId,line.accepted,line.rejected,line.shipped,id]);
      }
      await c.query("UPDATE order_intent SET state='acknowledged',external_order_id=$2,version=version+1 WHERE id=$1",[id,ack.externalOrderId]);
      await c.query("UPDATE submission_attempt SET outcome='acknowledged' WHERE intent_id=$1",[id]);
      await c.query("INSERT INTO procurement_outbox(organisation_id,branch_id,aggregate_id,event_type) VALUES($1,$2,$3,'OrderAcknowledged') ON CONFLICT DO NOTHING",[x.organisationId,x.branchId,id]);
      await releaseCompletedReservation(c,row.quote_id);return {state:'acknowledged'};
    });
  }
}
export async function confirmReceipt(client:RuntimeClient,context:TenantContext,intentId:string,reference:string,lines:{lineId:string;quantity:string}[]){
  if(context.organisationKind!=='pharmacy'||!['pharmacy_owner','receiver'].includes(context.role))throw new ProcurementError(403,'FORBIDDEN');
  if(!reference||reference.length>128||!lines.length||new Set(lines.map(l=>l.lineId)).size!==lines.length||lines.some(l=>!isPositiveDecimalString(l.quantity)))throw new ProcurementError(422,'INVALID_RECEIPT');
  const row=await intent(client,intentId);
  const hash=createHash('sha256').update(JSON.stringify([...lines].sort((a,b)=>a.lineId.localeCompare(b.lineId)))).digest('hex');
  const prior=(await client.query('SELECT id,request_hash FROM receipt WHERE intent_id=$1 AND reference=$2',[intentId,reference])).rows[0];
  if(prior){if(prior.request_hash!==hash)throw new ProcurementError(409,'IDEMPOTENCY_KEY_REUSED');return {id:prior.id};}
  if(row.state!=='acknowledged')throw new ProcurementError(409,'ORDER_NOT_ACKNOWLEDGED');
  for(const line of lines){
    const updated=await client.query('UPDATE order_line SET received=received+$3::numeric WHERE id=$1 AND intent_id=$2 AND received+$3::numeric<=shipped RETURNING id',[line.lineId,intentId,line.quantity]);
    if(!updated.rowCount)throw new ProcurementError(409,'RECEIPT_EXCEEDS_SHIPPED');
  }
  const id=randomUUID();
  await client.query('INSERT INTO receipt(id,organisation_id,branch_id,intent_id,reference,request_hash,lines) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,context.organisationId,context.branchId,intentId,reference,hash,JSON.stringify(lines)]);
  await client.query('INSERT INTO receipt_writeback(organisation_id,branch_id,receipt_id) VALUES($1,$2,$3)',[context.organisationId,context.branchId,id]);
  await releaseCompletedReservation(client,row.quote_id);return {id};
}
