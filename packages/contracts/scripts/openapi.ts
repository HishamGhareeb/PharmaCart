import { inventoryCommandSchema } from '../src/inventory-schema.ts';
import { quoteCommandSchema } from '../src/quote-schema.ts';

const uuid={type:'string',format:'uuid'};
const error={type:'object',additionalProperties:false,required:['error'],properties:{error:{type:'object',additionalProperties:false,required:['code','message','correlationId'],properties:{
  code:{type:'string',minLength:1,maxLength:64,pattern:'^[A-Za-z][A-Za-z0-9_]*$',description:'Extensible refusal code. Boundary and tenant codes are upper case (INVALID_REQUEST, IDEMPOTENCY_KEY_SCOPE_CONFLICT); an inventory refusal forwards the domain rejection reason verbatim in lower case (stale_sequence, conflicting_partition), so the code is deliberately not enumerated.'},
  message:{type:'string',minLength:1,description:'Fixed redacted sentence. It never echoes request values or internal detail.'},
  correlationId:uuid}}}};
const correlation={'X-Correlation-Id':{required:true,schema:uuid}};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const responses=(status:number,success:string,description:string)=>Object.fromEntries([status,400,401,403,404,409,413,422,500].map(code=>[String(code),{description:code<300?description:'Redacted error',headers:correlation,content:{'application/json':{schema:ref(code<300?success:'ErrorEnvelope')}}}]));
const scope=['X-Organisation-Id','X-Branch-Id'].map(name=>({name,in:'header',required:true,schema:uuid}));
const id={name:'id',in:'path',required:true,schema:uuid};
const body=(schema:unknown)=>({required:true,content:{'application/json':{schema}}});
// A numeric column rendered with ::text keeps its stored scale and never uses a sign or an exponent, so
// '1.0' and '7.500' are valid readings that a canonical pattern would wrongly refuse.
const stored=(description:string)=>({type:'string',pattern:'^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',description});
// Commercial amounts pass through canonical(), which strips trailing fractional zeros after rounding to
// two decimals, so '24.70' is never emitted for a total of '24.7'.
const money=(description:string)=>({type:'string',pattern:'^(?:0|0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$',description});
const counter=(description:string)=>({type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description});
const identity={type:'object',additionalProperties:true,required:['saleUnit'],description:'Catalogue identity snapshot copied from the verified procurement product. Only saleUnit is contractual: a line whose requested unit differs is refused with 422 UNIT_MISMATCH. Further catalogue attributes may be present and are passed through unchanged.',properties:{
  brand:{type:'string'},manufacturer:{type:'string'},strength:{type:'string'},dosageForm:{type:'string'},
  packSize:{type:'object',additionalProperties:true,required:['value','unit'],properties:{value:{type:'string'},unit:{type:'string'}}},
  saleUnit:{type:'string',minLength:1}}};
const quoteLine={type:'object',additionalProperties:false,required:['needId','needVersion','quantity','unit','mapId','mapVersion','productId','identity','offerId','offerVersion','termsVersion','supplierId','gross','discount','tax','fees','net'],properties:{
  needId:uuid,needVersion:counter('Need version the binding price was taken against.'),
  quantity:{type:'string',maxLength:24,pattern:'^(?:0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$',description:'Quantity echoed from the validated request, so it stays canonical and positive.'},
  unit:{type:'string',minLength:1,maxLength:32,description:'Requested sale unit, equal to the identity sale unit.'},
  mapId:uuid,mapVersion:counter('Verified source-product mapping version.'),productId:uuid,identity,
  offerId:uuid,offerVersion:counter('Account offer version the price came from.'),termsVersion:counter('Supplier relationship terms version, equal on the offer and the relationship.'),
  supplierId:uuid,gross:money('Line amount before adjustments.'),
  discount:money("Line discount. The synthetic cash tax-exempt rule always emits '0'."),
  tax:money("Line tax. The synthetic cash tax-exempt rule always emits '0'."),
  fees:money("Line fees. The synthetic cash tax-exempt rule always emits '0'."),
  net:money('Payable line amount, equal to gross under the synthetic rule.')}};
const needStatus=['open','quoted','covered','closed'];
const orderState=['queued','submitting','outcome_unknown','acknowledged','rejected','human_review'];
const storedPattern='^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$';
const uncertainty={oneOf:[
  {type:'object',additionalProperties:false,required:['safeToRetry','nextAction'],properties:{safeToRetry:{const:false},nextAction:{const:'reconciliation_required'}}},
  {type:'null'}],
  description:'Present while the state is submitting, outcome_unknown or human_review, and null otherwise. An uncertain outcome is never reported as safe to retry.'};
// Bounds mirrored from packages/db/src/lists.ts (MAX_LIMIT, MAX_CURSOR_LENGTH, MAX_SALE_UNIT_LENGTH) and
// packages/db/src/mapping.ts (MAX_MAPPING_CANDIDATES); apps/api/test/response-contracts.test.ts asserts they agree.
const MAX_PAGE_ITEMS=100;
const MAX_CURSOR_LENGTH=512;
const MAX_SALE_UNIT_LENGTH=64;
const MAX_MAPPING_CANDIDATES=20;
const cursorPattern='^[A-Za-z0-9_-]+$';
const count=(description:string)=>({type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,description});
const page=(item:unknown,description:string)=>({type:'object',additionalProperties:false,required:['items','nextCursor'],description,properties:{
  items:{type:'array',maxItems:MAX_PAGE_ITEMS,items:item,description:'At most the requested limit, in ascending identifier order. No total or count is ever reported.'},
  nextCursor:{type:['string','null'],minLength:1,maxLength:MAX_CURSOR_LENGTH,pattern:cursorPattern,description:'Opaque continuation bound to the resolved organisation, branch, resource and status filter. Null on the last page. A cursor from any other scope is refused with 400 INVALID_CURSOR, indistinguishable from a malformed one.'}}});
const needSummary={type:'object',additionalProperties:false,required:['id','productRef','quantity','outstandingQuantity','status','version','mappingStatus','productId','saleUnit'],properties:{
  id:uuid,productRef:{type:'string',minLength:1,description:'Source product reference carried from the inventory target.'},
  quantity:stored('Stored requested_quantity as numeric text, identical to GET /v1/needs/{id}.'),
  outstandingQuantity:{type:['string','null'],pattern:storedPattern,description:"The stored quantity while open, '0' once covered or closed, and null for a status whose outstanding demand the schema does not record (quoted). Never a fabricated zero."},
  status:{enum:needStatus},
  version:counter('Need version, identical to GET /v1/needs/{id}.'),
  mappingStatus:{enum:['unmapped','unverified','verified'],description:'verified only when the tenant mapping and the catalogue product it names are both verified.'},
  productId:{type:['string','null'],format:'uuid',description:'Disclosed only for a verified mapping; null otherwise.'},
  saleUnit:{type:['string','null'],minLength:1,maxLength:MAX_SALE_UNIT_LENGTH,description:'Catalogue sale unit, disclosed only for a verified mapping and only when stored as a plain string; never derived or converted.'}}};
const orderSummary={type:'object',additionalProperties:false,required:['id','state','version','externalClientRef','externalOrderId','lines','uncertainty'],properties:{
  id:uuid,state:{enum:orderState},
  version:counter('Intent version, identical to GET /v1/orders/{id}.'),
  externalClientRef:{type:'string',minLength:1,description:'Stable client reference, identical to GET /v1/orders/{id}.'},
  externalOrderId:{type:['string','null'],minLength:1,description:'Supplier order identity. Null until an acknowledgement is recorded.'},
  lines:{type:'object',additionalProperties:false,required:['total','settled','awaitingReceipt'],description:'Line counts only. Quantities are never summed because lines may carry different sale units; per-line quantities stay on GET /v1/orders/{id}.',properties:{
    total:count('Lines materialised for the intent; 0 while queued.'),
    settled:count('Lines whose accepted plus rejected equals ordered and whose received equals accepted.'),
    awaitingReceipt:count('Lines with received below shipped.')}},
  uncertainty}};
const exactText=(description:string)=>({type:'string',minLength:1,pattern:'^\\S(?:[\\s\\S]*\\S)?$',description});
const catalogueIdentity={type:'object',additionalProperties:false,required:['brand','manufacturer','strength','dosageForm','packSize','saleUnit'],description:'Complete verified catalogue pack identity. A pack missing any field is never offered.',properties:{
  brand:exactText('Brand name.'),manufacturer:exactText('Manufacturer.'),strength:exactText('Strength as recorded.'),dosageForm:exactText('Dosage form.'),
  packSize:{type:'object',additionalProperties:false,required:['value','unit'],properties:{
    value:{type:'string',maxLength:32,pattern:'^(?:0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$',description:'Positive canonical decimal string.'},
    unit:exactText('Unit of the pack size.')}},
  saleUnit:exactText('Unit the pack is sold in; compared by exact equality, never converted.')}};
// Served as the Fastify body schema by apps/api/src/mapping-routes.ts, so the document and the route cannot diverge.
export const mappingCommandSchema={type:'object',additionalProperties:false,required:['needVersion','productId'],description:'One explicit human selection. Nothing is inferred, folded or converted.',properties:{
  needVersion:{type:'integer',minimum:1,maximum:2147483647,description:'Need version the selection was made against; a different current version is refused with 409 NEED_VERSION_CONFLICT.'},
  productId:{type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',description:'Chosen verified catalogue pack.'},
  suppliedUnit:{type:'string',minLength:1,maxLength:32,description:'Required only when the need carries no authoritative unit metadata, and then equal to the chosen sale unit exactly.'}}};
const listQuery=(statuses:readonly string[],resource:string)=>[
  {name:'limit',in:'query',required:false,description:'Page size from 1 to 100 as a plain decimal string; 25 when omitted.',schema:{type:'string',pattern:'^(?:[1-9][0-9]?|100)$'}},
  {name:'status',in:'query',required:false,description:`Exact ${resource} status filter. Any other value is refused with 400 INVALID_REQUEST.`,schema:{enum:statuses}},
  {name:'cursor',in:'query',required:false,description:'nextCursor from the previous page of the same resource, scope and status filter.',schema:{type:'string',minLength:1,maxLength:MAX_CURSOR_LENGTH,pattern:cursorPattern}}];
const orderLine={type:'object',additionalProperties:false,required:['id','productIdentity','ordered','accepted','rejected','shipped','received'],properties:{
  id:uuid,productIdentity:identity,
  ordered:stored('Quantity ordered from the supplier for this line.'),
  accepted:stored("Supplier accepted quantity; '0' until an acknowledgement settles the line."),
  rejected:stored('Supplier rejected quantity; accepted plus rejected never exceeds ordered.'),
  shipped:stored('Supplier shipped quantity; never greater than accepted.'),
  received:stored('Confirmed received quantity; never greater than shipped. Receipts add to it, so the reading keeps the widest scale of the amounts summed.')}};
const schemas={
  ErrorEnvelope:error,
  HealthStatus:{type:'object',additionalProperties:false,required:['status'],description:'Liveness of the process only. It reports no dependency, database or version detail.',properties:{status:{const:'ok'}}},
  OpenapiDocument:{type:'object',additionalProperties:false,required:['openapi','info','security','components','paths'],description:'The generated document served by this endpoint, byte for byte the packaged packages/contracts/openapi.json.',properties:{
    openapi:{const:'3.1.0'},
    info:{type:'object',additionalProperties:false,required:['title','version','description'],properties:{title:{type:'string',minLength:1},version:{type:'string',minLength:1},description:{type:'string',minLength:1}}},
    security:{type:'array',minItems:1,items:{type:'object'}},
    components:{type:'object',additionalProperties:true,required:['securitySchemes','schemas'],properties:{securitySchemes:{type:'object'},schemas:{type:'object'}}},
    paths:{type:'object',minProperties:1}}},
  TenantContext:{type:'object',additionalProperties:false,required:['principalKind','userSubject','membershipId','organisationId','organisationKind','branchId','allowedBranchIds','role','membershipVersion'],description:'Scope resolved for this request from the verified token subject and the requested organisation and branch headers. It carries no token, no credential and no other membership.',properties:{
    principalKind:{const:'member',description:'Only member principals reach the tenant routes; service principals are not implemented.'},
    userSubject:{type:'string',minLength:1,description:'Verified access token subject.'},
    membershipId:uuid,organisationId:uuid,
    organisationKind:{enum:['pharmacy','supplier'],description:'Purchasing and receipt routes additionally require a pharmacy organisation.'},
    branchId:uuid,
    allowedBranchIds:{type:'array',minItems:1,maxItems:1,items:uuid,description:'Exactly the requested branch: one transaction never widens beyond the branch its row level security policy is set to.'},
    role:{enum:['pharmacy_owner','purchaser','receiver','supplier_operator','supplier_administrator','support'],description:'Active membership role. Quoting and approval require pharmacy_owner or purchaser; receipts require pharmacy_owner or receiver. Need and order lists and mapping candidates require pharmacy_owner or purchaser; binding a mapping requires pharmacy_owner.'},
    membershipVersion:counter('Version of the active membership row used for this request.')}},
  NeedView:{type:'object',additionalProperties:false,required:['id','productRef','quantity','status','version'],description:'Single need in the requested branch. A need outside the scope is indistinguishable from a missing one.',properties:{
    id:uuid,productRef:{type:'string',minLength:1,description:'Source product reference carried from the inventory target.'},
    quantity:stored('Stored requested_quantity as numeric text. It is the outstanding remainder while the status is open, and the frozen final tranche once the status is covered.'),
    status:{enum:['open','quoted','covered','closed']},
    version:counter('Incremented whenever an approval settles part of the need, which invalidates an earlier quote.')}},
  InventoryAcceptance:{type:'object',additionalProperties:false,required:['eventId','status','duplicate','projectionRevision'],description:'Durable outcome of one snapshot event. The inbox write, projection and derived needs are committed before this acknowledgement; a rejected event is refused with an error envelope instead.',properties:{
    eventId:{type:'string',minLength:1,maxLength:256,pattern:'^[^\\u0000]+$',description:'Event identifier echoed from the validated command.'},
    status:{const:'processed'},
    duplicate:{type:'boolean',description:'True when the event was already recorded and nothing changed.'},
    projectionRevision:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,description:'Revision of the installation projection after the event; 0 before any partition has been completed.'}}},
  Quote:{type:'object',additionalProperties:false,required:['id','version','status','bindingStatus','currency','expiresAt','pricingRuleVersion','termsHash','lines','unmetLines','total'],description:'Binding synthetic quote. Creation is all or nothing: a line without a verified mapping or a binding offer refuses the request with 422 rather than returning a partial quote.',properties:{
    id:uuid,
    version:{const:1,description:'Creation always returns version 1; the stored quote version is never incremented.'},
    status:{const:'quoted'},
    bindingStatus:{const:'binding'},
    currency:{const:'EGP',description:'The quote table constrains the currency to EGP for the synthetic fixtures.'},
    expiresAt:{type:'string',format:'date-time',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',description:'UTC instant, the earlier of the five minute quote lifetime and the earliest offer expiry.'},
    pricingRuleVersion:{const:'synthetic-cash-tax-exempt-v1',description:'Synthetic cash, tax-exempt pricing rule. It is a fixture identifier, not a configured commercial policy: discount, tax and fees are always zero and no mapping administration or supplier selection policy is applied.'},
    termsHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'SHA-256 digest over the quoted lines.'},
    lines:{type:'array',minItems:1,maxItems:100,items:quoteLine},
    unmetLines:{type:'array',maxItems:0,description:'Always empty. An unsatisfiable line refuses the whole quote, so unmet demand is never reported here.'},
    total:money('Sum of the line net amounts, rounded to two decimals by the database.')}},
  ApprovalResult:{type:'object',additionalProperties:false,required:['approvalId','quoteId','quoteVersion','status','orderIntentIds'],description:'Result of approving a quote. 202 records a new approval, budget reservation and one order intent per supplier; 200 reports an already approved quote under a new idempotency key. An identical key replays its original status and body, including 202. Both statuses carry this shape.',properties:{
    approvalId:uuid,quoteId:uuid,
    quoteVersion:counter('Quote version echoed from the validated command.'),
    status:{const:'queued',description:'Submission is queued through the transactional outbox; no supplier has been contacted at this point.'},
    orderIntentIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:uuid,description:'One intent per distinct supplier in the quote, in ascending supplier order.'}}},
  OrderDetail:{type:'object',additionalProperties:false,required:['id','state','externalClientRef','externalOrderId','version','lines','uncertainty'],description:'Order intent in the requested branch with its supplier settled quantities.',properties:{
    id:uuid,
    state:{enum:['queued','submitting','outcome_unknown','acknowledged','rejected','human_review']},
    externalClientRef:{type:'string',minLength:1,description:'Stable client reference used for every submission and lookup of this intent; it survives a restore.'},
    externalOrderId:{type:['string','null'],minLength:1,description:'Supplier order identity. Null until an acknowledgement is recorded, and never replaced afterwards.'},
    version:counter('Intent version, incremented by every state transition.'),
    lines:{type:'array',maxItems:100,items:orderLine,description:'Empty until the worker materialises the lines when it claims the intent for submission.'},
    uncertainty}},
  ReceiptAcknowledgement:{type:'object',additionalProperties:false,required:['id'],description:'Identity of the stored receipt. Repeating the same reference and lines returns the same identity; the same reference with different lines is refused with 409 IDEMPOTENCY_KEY_REUSED.',properties:{id:uuid}},
  NeedPage:page(needSummary,'One keyset page of needs in the resolved branch. Row level security is the only tenant predicate.'),
  OrderPage:page(orderSummary,'One keyset page of order intents in the resolved branch. No counterparty, quote or pricing is disclosed.'),
  MappingCandidates:{type:'object',additionalProperties:false,required:['needId','needVersion','needStatus','productRef','currentProductId','authoritativeUnit','unitBasis','selectionRequired','ambiguous','truncated','unselectableExcluded','candidates'],description:'Verified shared catalogue packs a person may choose for one need. It carries pack identity only: no offer, price or supplier, and no candidate is marked as chosen.',properties:{
    needId:uuid,needVersion:counter('Need version to send back as needVersion when binding.'),
    needStatus:{enum:needStatus},
    productRef:{type:'string',minLength:1,description:'Source product reference of the need.'},
    currentProductId:{type:['string','null'],format:'uuid',description:'Product of the current mapping, or null when the need is unmapped.'},
    authoritativeUnit:{type:['string','null'],minLength:1,description:'Unit stated by the connector target that produced the need, or null when none is recorded.'},
    unitBasis:{enum:['authoritative_metadata','explicit_supplied_unit_required'],description:'explicit_supplied_unit_required means a bind must state suppliedUnit equal to the chosen sale unit.'},
    selectionRequired:{const:true,description:'Always true: even a single eligible candidate is a human decision.'},
    ambiguous:{type:'boolean',description:'True when more than one candidate is eligible.'},
    truncated:{type:'boolean',description:'True when the catalogue window exceeded the candidate bound, so the list is not exhaustive.'},
    unselectableExcluded:{type:'integer',minimum:0,maximum:MAX_MAPPING_CANDIDATES+1,description:'Rows in the fetched catalogue window withheld for an incomplete identity or a different unit.'},
    candidates:{type:'array',maxItems:MAX_MAPPING_CANDIDATES,items:{type:'object',additionalProperties:false,required:['productId','identity'],properties:{productId:uuid,identity:catalogueIdentity}},description:'Ascending product identifier order.'}}},
  MappingResult:{type:'object',additionalProperties:false,required:['needId','needVersion','mapId','productId','mapStatus','unit','unitBasis','decisionId','repeated'],description:'The recorded explicit human mapping decision. 201 records a new mapping and increments the need version, which invalidates quotes taken at the earlier version; 200 reports the same selection repeated at the current version, with nothing changed.',properties:{
    needId:uuid,needVersion:counter('Need version after the request.'),mapId:uuid,productId:uuid,
    mapStatus:{const:'verified'},
    unit:exactText('Unit the decision is recorded against, equal to the catalogue sale unit.'),
    unitBasis:{enum:['authoritative_metadata','explicit_supplied_unit'],description:'Whether the unit came from connector metadata or from the suppliedUnit the request stated.'},
    decisionId:{...uuid,description:'Provenance decision row. The repository returns one on both outcomes.'},
    repeated:{type:'boolean',description:'False with 201, true with 200.'}}},
};
export const receiptCommandSchema={type:'object',additionalProperties:false,required:['reference','lines'],properties:{reference:{type:'string',minLength:1,maxLength:128},lines:{type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,required:['lineId','quantity'],properties:{lineId:{type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'},quantity:{type:'string',maxLength:24,pattern:'^(?:0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$'}}}}}};
export const approvalCommandSchema={type:'object',additionalProperties:false,required:['quoteVersion'],properties:{quoteVersion:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}}};
export function renderOpenapi(){return JSON.stringify({openapi:'3.1.0',info:{title:'PharmaCart synthetic API',version:'0.2.0',description:'Local B0-B3 backend. Cash EGP tax-exempt fixtures only; no real suppliers.'},security:[{oidc:[]}],
  components:{securitySchemes:{oidc:{type:'http',scheme:'bearer',bearerFormat:'JWT'}},schemas},
  paths:{
    '/health':{get:{operationId:'getHealth',security:[],responses:responses(200,'HealthStatus','Process liveness')}},
    '/openapi.json':{get:{operationId:'getOpenapi',security:[],responses:responses(200,'OpenapiDocument','The generated contract document')}},
    '/v1/context':{get:{operationId:'getContext',parameters:scope,responses:responses(200,'TenantContext','Resolved membership scope for the request')}},
    '/v1/needs':{get:{operationId:'listNeeds',description:'Requires a pharmacy organisation and the role pharmacy_owner or purchaser; any other principal is refused with 403 FORBIDDEN, worded exactly as a denied membership. A malformed query is refused with 400 INVALID_REQUEST and an unusable cursor with 400 INVALID_CURSOR, the latter only after authentication.',parameters:[...scope,...listQuery(needStatus,'need')],responses:responses(200,'NeedPage','One page of needs inside the resolved scope')}},
    '/v1/needs/{id}':{get:{operationId:'getNeed',parameters:[...scope,id],responses:responses(200,'NeedView','The requested need inside the resolved scope')}},
    '/v1/needs/{id}/mapping-candidates':{get:{operationId:'getMappingCandidates',description:'Requires a pharmacy organisation and the role pharmacy_owner or purchaser. A need outside the scope is refused with 404 NOT_FOUND, indistinguishable from a missing one; conflicting connector units are refused with 409 AMBIGUOUS_NEED_UNIT.',parameters:[...scope,id],responses:responses(200,'MappingCandidates','Selectable catalogue packs for the need')}},
    '/v1/needs/{id}/mapping':{post:{operationId:'bindNeedMapping',description:'Requires a pharmacy organisation and the role pharmacy_owner only. Refusals: 404 NOT_FOUND; 409 NEED_VERSION_CONFLICT, NEED_NOT_OPEN, AMBIGUOUS_NEED_UNIT or MAPPING_DECISION_CONFLICT; 422 CATALOGUE_UNVERIFIED, CATALOGUE_IDENTITY_INCOMPLETE, SUPPLIED_UNIT_REQUIRED or UNIT_MISMATCH.',parameters:[...scope,id],requestBody:body(mappingCommandSchema),responses:{...responses(201,'MappingResult','New explicit mapping decision recorded'),'200':{description:'Same selection repeated at the current need version; nothing changed',headers:correlation,content:{'application/json':{schema:ref('MappingResult')}}}}}},
    '/v1/inventory':{post:{operationId:'ingestInventory',description:'Installation scope derives from the verified subject. Durable processing completes before acknowledgement.',requestBody:body(inventoryCommandSchema),responses:responses(202,'InventoryAcceptance','Snapshot event processed durably')}},
    '/v1/quotes':{post:{operationId:'createQuote',parameters:scope,requestBody:body(quoteCommandSchema),responses:responses(201,'Quote','Binding quote created')}},
    '/v1/quotes/{id}/approve':{post:{operationId:'approveQuote',parameters:[...scope,id,{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'}}],requestBody:body(approvalCommandSchema),responses:{...responses(202,'ApprovalResult','Approval recorded and supplier submission queued'),'200':{description:'Already approved quote under a new idempotency key',headers:correlation,content:{'application/json':{schema:ref('ApprovalResult')}}}}}},
    '/v1/orders':{get:{operationId:'listOrders',description:'Requires a pharmacy organisation and the role pharmacy_owner or purchaser; any other principal is refused with 403 FORBIDDEN, worded exactly as a denied membership. A malformed query is refused with 400 INVALID_REQUEST and an unusable cursor with 400 INVALID_CURSOR, the latter only after authentication.',parameters:[...scope,...listQuery(orderState,'order intent')],responses:responses(200,'OrderPage','One page of order intents inside the resolved scope')}},
    '/v1/orders/{id}':{get:{operationId:'getOrder',parameters:[...scope,id],responses:responses(200,'OrderDetail','The requested order intent inside the resolved scope')}},
    '/v1/orders/{id}/receipts':{post:{operationId:'confirmReceipt',parameters:[...scope,id],requestBody:body(receiptCommandSchema),responses:responses(200,'ReceiptAcknowledgement','Receipt recorded and queued for writeback')}},
  },
},null,2)+'\n';}
