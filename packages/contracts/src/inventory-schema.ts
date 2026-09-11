const source = { type:'string',minLength:1,maxLength:256,pattern:'^[^\\u0000]+$' };
const scope = {eventId:source,snapshotId:source,sequence:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}};
export const inventoryCommandSchema = {
  oneOf:[
    {type:'object',additionalProperties:false,required:['kind','eventId','snapshotId','sequence','partitionId','rows'],
      properties:{...scope,kind:{const:'partition'},partitionId:source,rows:{type:'array',maxItems:1000,items:{
        type:'object',additionalProperties:false,required:['sourceCode','quantity','unit'],properties:{sourceCode:source,unit:source,
          quantity:{type:'string',maxLength:128,pattern:'^(?:0|0\\.[0-9]*[1-9]|[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$'}}}}}},
    {type:'object',additionalProperties:false,required:['kind','eventId','snapshotId','sequence','expectedPartitionIds'],
      properties:{...scope,kind:{const:'complete'},expectedPartitionIds:{type:'array',minItems:1,maxItems:1000,uniqueItems:true,items:source}}},
  ],
};
