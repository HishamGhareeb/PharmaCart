import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';

export type SupplierLine={lineId:string;quantity:string};
export type Acknowledgement={externalOrderId:string;lines:{lineId:string;accepted:string;rejected:string;shipped:string}[]};
type Ledger={submitCalls:number;lookupCalls:number;orders:Record<string,Acknowledgement>};
function lessOne(quantity:string) {
  const [whole,fraction='']=quantity.split('.');const scale=10n**BigInt(fraction.length);
  const value=BigInt(whole!)*scale+BigInt(fraction||'0');
  if(value<=scale)return {accepted:'0',rejected:quantity};
  return {accepted:[String(BigInt(whole!)-1n),fraction].filter(Boolean).join('.'),rejected:'1'};
}
export class FakeSupplier {
  readonly path:string;readonly mode:'accepted'|'partial'|'timeout_after_accept';
  private serial:Promise<unknown>=Promise.resolve();
  constructor(path:string,mode:'accepted'|'partial'|'timeout_after_accept'='partial'){this.path=path;this.mode=mode;}
  async ledger():Promise<Ledger>{
    try{return JSON.parse(await readFile(this.path,'utf8')) as Ledger;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {submitCalls:0,lookupCalls:0,orders:{}};throw error;}
  }
  private change<T>(action:(ledger:Ledger)=>T):Promise<T>{
    const result=this.serial.then(async()=>{
      const ledger=await this.ledger();const value=action(ledger);
      await mkdir(dirname(this.path),{recursive:true});const temporary=`${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary,JSON.stringify(ledger));await rename(temporary,this.path);return value;
    });this.serial=result.catch(()=>undefined);return result;
  }
  async submit(reference:string,lines:SupplierLine[]):Promise<Acknowledgement>{
    if(!reference.startsWith('pc-syn-')||!lines.length||lines.some(l=>!isPositiveDecimalString(l.quantity)))throw new Error('Invalid synthetic submission');
    const result=await this.change(ledger=>{
      ledger.submitCalls++;
      if(!Object.hasOwn(ledger.orders,reference))ledger.orders[reference]={externalOrderId:`syn-${randomUUID()}`,lines:lines.map(l=>{
        const amounts=this.mode==='accepted'?{accepted:l.quantity,rejected:'0'}:lessOne(l.quantity);
        return {lineId:l.lineId,...amounts,shipped:amounts.accepted};
      })};
      return ledger.orders[reference]!;
    });
    if(this.mode==='timeout_after_accept')throw new Error('Synthetic connection lost after acceptance');
    return result;
  }
  async lookup(reference:string):Promise<Acknowledgement|undefined>{
    return this.change(ledger=>{ledger.lookupCalls++;return Object.hasOwn(ledger.orders,reference)?ledger.orders[reference]:undefined;});
  }
}
