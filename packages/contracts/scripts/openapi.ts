import { inventoryCommandSchema } from '../src/inventory-schema.ts';
import { quoteCommandSchema } from '../src/quote-schema.ts';

const uuid={type:'string',format:'uuid'};
const error={type:'object',additionalProperties:false,required:['error'],properties:{error:{type:'object',additionalProperties:false,required:['code','message','correlationId'],properties:{code:{type:'string'},message:{type:'string'},correlationId:uuid}}}};
const correlation={'X-Correlation-Id':{required:true,schema:uuid}};
const responses=(status:number)=>Object.fromEntries([status,400,401,403,404,409,413,422,500].map(code=>[String(code),{description:code<300?'Successful response':'Redacted error',headers:correlation,content:{'application/json':{schema:code<300?{type:'object'}:error}}}]));
const scope=['X-Organisation-Id','X-Branch-Id'].map(name=>({name,in:'header',required:true,schema:uuid}));
const id={name:'id',in:'path',required:true,schema:uuid};
const body=(schema:unknown)=>({required:true,content:{'application/json':{schema}}});
export const receiptCommandSchema={type:'object',additionalProperties:false,required:['reference','lines'],properties:{reference:{type:'string',minLength:1,maxLength:128},lines:{type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,required:['lineId','quantity'],properties:{lineId:{type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'},quantity:{type:'string',maxLength:24,pattern:'^(?:0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$'}}}}}};
export const approvalCommandSchema={type:'object',additionalProperties:false,required:['quoteVersion'],properties:{quoteVersion:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}}};
export function renderOpenapi(){return JSON.stringify({openapi:'3.1.0',info:{title:'PharmaCart synthetic API',version:'0.2.0',description:'Local B0-B3 backend. Cash EGP tax-exempt fixtures only; no real suppliers.'},security:[{oidc:[]}],
  components:{securitySchemes:{oidc:{type:'http',scheme:'bearer',bearerFormat:'JWT'}},schemas:{ErrorEnvelope:error}},
  paths:{
    '/health':{get:{operationId:'getHealth',security:[],responses:responses(200)}},
    '/openapi.json':{get:{operationId:'getOpenapi',security:[],responses:responses(200)}},
    '/v1/context':{get:{operationId:'getContext',parameters:scope,responses:responses(200)}},
    '/v1/needs/{id}':{get:{operationId:'getNeed',parameters:[...scope,id],responses:responses(200)}},
    '/v1/inventory':{post:{operationId:'ingestInventory',description:'Installation scope derives from the verified subject. Durable processing completes before acknowledgement.',requestBody:body(inventoryCommandSchema),responses:responses(202)}},
    '/v1/quotes':{post:{operationId:'createQuote',parameters:scope,requestBody:body(quoteCommandSchema),responses:responses(201)}},
    '/v1/quotes/{id}/approve':{post:{operationId:'approveQuote',parameters:[...scope,id,{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'}}],requestBody:body(approvalCommandSchema),responses:{...responses(202),'200':responses(200)['200']}}},
    '/v1/orders/{id}':{get:{operationId:'getOrder',parameters:[...scope,id],responses:responses(200)}},
    '/v1/orders/{id}/receipts':{post:{operationId:'confirmReceipt',parameters:[...scope,id],requestBody:body(receiptCommandSchema),responses:responses(200)}},
  },
},null,2)+'\n';}
