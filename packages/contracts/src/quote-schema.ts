const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
export const quoteCommandSchema={type:'object',additionalProperties:false,required:['branchId','lines','constraints'],properties:{
  branchId:uuid,lines:{type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,required:['needId','needVersion','quantity','unit'],properties:{
    needId:uuid,needVersion:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
    quantity:{type:'string',maxLength:24,pattern:'^(?:0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$'},unit:{type:'string',minLength:1,maxLength:32}}}},
  constraints:{type:'object',additionalProperties:false,required:['supplierIds','paymentTerm'],properties:{supplierIds:{type:'array',maxItems:100,uniqueItems:true,items:uuid},paymentTerm:{const:'cash'}}},
}};
