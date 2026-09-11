import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeClient, TenantContext } from './runtime.ts';

export class ProcurementError extends Error {
  readonly status: number; readonly code: string;
  constructor(status:number,code:string) {super(code);this.status=status;this.code=code;}
}
export const canonical = (value:string) => value.includes('.') ? value.replace(/0+$/,'').replace(/\.$/,'') : value;
export type QuoteCommand={branchId:string;lines:{needId:string;needVersion:number;quantity:string;unit:string}[];constraints:{supplierIds:string[];paymentTerm:'cash'}};
export type QuoteLine={needId:string;needVersion:number;quantity:string;unit:string;mapId:string;mapVersion:number;productId:string;identity:unknown;offerId:string;offerVersion:number;termsVersion:number;supplierId:string;gross:string;discount:string;tax:string;fees:string;net:string};
function canPurchase(context:TenantContext) {
  if(context.organisationKind!=='pharmacy'||!['pharmacy_owner','purchaser'].includes(context.role))throw new ProcurementError(403,'FORBIDDEN');
}
export async function createQuote(client:RuntimeClient,context:TenantContext,command:QuoteCommand) {
  canPurchase(context);
  if(command.branchId!==context.branchId)throw new ProcurementError(404,'NOT_FOUND');
  const lines:QuoteLine[]=[];let expiry=Date.now()+300000;
  if(new Set(command.lines.map(l=>l.needId)).size!==command.lines.length)throw new ProcurementError(422,'DUPLICATE_NEED');
  for(const line of command.lines) {
    const need=(await client.query(`SELECT n.*,m.id AS map_id,m.status AS map_status,m.version AS map_version,p.id AS product_id,p.identity,p.status AS product_status
      FROM need n LEFT JOIN source_product_map m ON m.id=n.source_map_id LEFT JOIN procurement_product p ON p.id=m.product_id WHERE n.id=$1`,[line.needId])).rows[0];
    if(!need)throw new ProcurementError(404,'NOT_FOUND');
    if(need.status!=='open'||need.version!==line.needVersion)throw new ProcurementError(409,'NEED_CHANGED');
    if(need.map_status!=='verified'||need.product_status!=='verified')throw new ProcurementError(422,'MAPPING_UNVERIFIED');
    if(need.identity.saleUnit!==line.unit)throw new ProcurementError(422,'UNIT_MISMATCH');
    const offer=(await client.query(`SELECT o.*,r.supplier_id,round(o.unit_price*$2::numeric,2)::text AS net FROM account_offer o JOIN supplier_relationship r ON r.id=o.relationship_id
      JOIN organisation own_org ON own_org.id=o.organisation_id
      WHERE o.product_id=$1 AND o.unit=$3 AND o.expires_at>now() AND o.available_quantity>=$2::numeric AND $2::numeric<=$4::numeric
      AND r.status='active' AND o.terms_version=r.terms_version AND own_org.verification_status='verified'
      AND (cardinality($5::uuid[])=0 OR r.supplier_id=ANY($5::uuid[])) ORDER BY o.unit_price,o.id LIMIT 1`,[need.product_id,line.quantity,line.unit,need.requested_quantity,command.constraints.supplierIds])).rows[0];
    if(!offer)throw new ProcurementError(422,'NO_BINDING_OFFER');
    expiry=Math.min(expiry,new Date(offer.expires_at).getTime());
    lines.push({...line,mapId:need.map_id,mapVersion:need.map_version,productId:need.product_id,identity:need.identity,
      offerId:offer.id,offerVersion:offer.version,termsVersion:offer.terms_version,supplierId:offer.supplier_id,gross:canonical(offer.net),discount:'0',tax:'0',fees:'0',net:canonical(offer.net)});
  }
  const total=canonical((await client.query("SELECT sum((item->>'net')::numeric)::text AS total FROM jsonb_array_elements($1::jsonb) item",[JSON.stringify(lines)])).rows[0].total);
  const id=randomUUID();const expiresAt=new Date(expiry).toISOString();const termsHash=createHash('sha256').update(JSON.stringify(lines)).digest('hex');
  await client.query("INSERT INTO quote(id,organisation_id,branch_id,version,status,total,currency,expires_at,terms_hash,lines) VALUES($1,$2,$3,1,'quoted',$4,'EGP',$5,$6,$7)",[id,context.organisationId,context.branchId,total,expiresAt,termsHash,JSON.stringify(lines)]);
  return {id,version:1,status:'quoted',bindingStatus:'binding',currency:'EGP',expiresAt,pricingRuleVersion:'synthetic-cash-tax-exempt-v1',termsHash,lines,unmetLines:[],total};
}
export async function approveQuote(client:RuntimeClient,context:TenantContext,quoteId:string,quoteVersion:number,key:string) {
  canPurchase(context);
  const hash=createHash('sha256').update(JSON.stringify({quoteId,quoteVersion})).digest('hex');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.organisationId}:approve:${key}`]);
  const replay=(await client.query("SELECT * FROM command_result WHERE organisation_id=$1 AND operation='approve_quote' AND key=$2",[context.organisationId,key])).rows[0];
  if(replay) {if(replay.request_hash!==hash)throw new ProcurementError(409,'IDEMPOTENCY_KEY_REUSED');return {status:replay.status,body:replay.body};}
  const quote=(await client.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM quote WHERE id=$1 FOR UPDATE',[quoteId])).rows[0];
  if(!quote)throw new ProcurementError(404,'NOT_FOUND');
  if(quote.version!==quoteVersion)throw new ProcurementError(409,'VERSION_CONFLICT');
  let approvalId:string;let status:number;let intentIds:string[];
  if(quote.status==='approved') {
    approvalId=(await client.query('SELECT id FROM approval WHERE quote_id=$1',[quoteId])).rows[0].id;
    intentIds=(await client.query('SELECT id FROM order_intent WHERE quote_id=$1 ORDER BY supplier_id',[quoteId])).rows.map(r=>r.id);status=200;
  } else {
    if(!quote.fresh)throw new ProcurementError(409,'REQUOTE_REQUIRED');
    const lines=quote.lines as QuoteLine[];
    for(const line of [...lines].sort((a,b)=>a.needId.localeCompare(b.needId))) {
      const current=(await client.query(`SELECT o.version AS offer_version,o.terms_version,r.terms_version AS relationship_terms,r.status AS relationship_status,o.expires_at>clock_timestamp() AS fresh,
        n.version AS need_version,n.status AS need_status,m.version AS map_version,m.status AS map_status,p.status AS product_status,org.verification_status,
        o.available_quantity>=$2::numeric AS available
        FROM account_offer o JOIN supplier_relationship r ON r.id=o.relationship_id JOIN need n ON n.id=$3
        JOIN source_product_map m ON m.id=n.source_map_id JOIN procurement_product p ON p.id=m.product_id JOIN organisation org ON org.id=n.organisation_id
        WHERE o.id=$1 FOR UPDATE OF n FOR SHARE OF o,r,m,p,org`,[line.offerId,line.quantity,line.needId])).rows[0];
      if(!current||!current.fresh||!current.available||current.offer_version!==line.offerVersion||current.terms_version!==line.termsVersion||current.relationship_terms!==line.termsVersion||current.relationship_status!=='active'
        ||current.need_version!==line.needVersion||current.need_status!=='open'||current.map_version!==line.mapVersion||current.map_status!=='verified'||current.product_status!=='verified'||current.verification_status!=='verified')throw new ProcurementError(409,'REQUOTE_REQUIRED');
    }
    const period=(await client.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM') AS period")).rows[0].period;
    const reserved=await client.query('UPDATE budget SET reserved_amount=reserved_amount+$4::numeric WHERE organisation_id=$1 AND branch_id=$2 AND period=$3 AND currency=$5 AND reserved_amount+$4::numeric<=limit_amount RETURNING period',[context.organisationId,context.branchId,period,quote.total,quote.currency]);
    if(!reserved.rowCount)throw new ProcurementError(409,'BUDGET_EXCEEDED');
    approvalId=randomUUID();intentIds=[];status=202;
    await client.query('INSERT INTO approval(id,organisation_id,branch_id,quote_id,actor_id) VALUES($1,$2,$3,$4,$5)',[approvalId,context.organisationId,context.branchId,quoteId,context.membershipId]);
    await client.query('INSERT INTO budget_reservation(organisation_id,branch_id,quote_id,amount,currency,period) VALUES($1,$2,$3,$4,$5,$6)',[context.organisationId,context.branchId,quoteId,quote.total,quote.currency,period]);
    for(const supplierId of [...new Set(lines.map(l=>l.supplierId))].sort()) {
      const id=randomUUID();intentIds.push(id);
      await client.query("INSERT INTO order_intent(id,organisation_id,branch_id,quote_id,supplier_id,external_client_ref,state) VALUES($1,$2,$3,$4,$5,$6,'queued')",[id,context.organisationId,context.branchId,quoteId,supplierId,`pc-syn-${id}`]);
      await client.query("INSERT INTO procurement_outbox(organisation_id,branch_id,aggregate_id,event_type) VALUES($1,$2,$3,'OrderSubmissionRequested')",[context.organisationId,context.branchId,id]);
    }
    for(const line of lines)await client.query("UPDATE need SET status='covered',version=version+1 WHERE id=$1",[line.needId]);
    await client.query("UPDATE quote SET status='approved' WHERE id=$1",[quoteId]);
    await client.query("INSERT INTO procurement_outbox(organisation_id,branch_id,aggregate_id,event_type) VALUES($1,$2,$3,'QuoteApproved')",[context.organisationId,context.branchId,quoteId]);
  }
  const body={approvalId,quoteId,quoteVersion,status:'queued',orderIntentIds:intentIds};
  await client.query("INSERT INTO command_result(organisation_id,branch_id,operation,key,request_hash,status,body) VALUES($1,$2,'approve_quote',$3,$4,$5,$6)",[context.organisationId,context.branchId,key,hash,status,body]);
  return {status,body};
}
