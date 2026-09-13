import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isPositiveDecimalString } from '../../contracts/src/decimal.ts';

export type SupplierLine={lineId:string;quantity:string};
export type Acknowledgement={externalOrderId:string;lines:{lineId:string;accepted:string;rejected:string;shipped:string}[]};
export type FakeSupplierOptions={lockWaitMs?:number;lockPollMs?:number};
type Ledger={submitCalls:number;lookupCalls:number;orders:Record<string,Acknowledgement>};
type Marker={owner:string;pid:number;acquiredAt:string};
/** Raised when exclusive ledger access cannot be obtained within the bound. The caller must treat the
 * synthetic outcome as unknown; it must never assume the ledger is empty or safe to overwrite. */
export class SupplierLedgerLockError extends Error {
  readonly code='SUPPLIER_LEDGER_LOCKED';readonly markerPath:string;
  constructor(markerPath:string,waitedMs:number){
    super(`Synthetic supplier ledger remained locked for ${waitedMs}ms; refusing to read or write it`);
    this.name='SupplierLedgerLockError';this.markerPath=markerPath;
  }
}
/** Acquisition bounds must be whole milliseconds inside these limits. A NaN or infinite value cannot end a
 * wait, and the maxima keep a refusal recognisable rather than indistinguishable from a hang. */
const lockBounds={lockWaitMs:{min:0,max:60_000},lockPollMs:{min:1,max:1_000}} as const;
function boundedMilliseconds(name:keyof typeof lockBounds,value:number):number{
  const {min,max}=lockBounds[name];
  if(!Number.isInteger(value)||value<min||value>max)
    throw new RangeError(`${name} must be a whole number of milliseconds between ${min} and ${max}; received ${String(value)}`);
  return value;
}
function lessOne(quantity:string) {
  const [whole,fraction='']=quantity.split('.');const scale=10n**BigInt(fraction.length);
  const value=BigInt(whole!)*scale+BigInt(fraction||'0');
  if(value<=scale)return {accepted:'0',rejected:quantity};
  return {accepted:[String(BigInt(whole!)-1n),fraction].filter(Boolean).join('.'),rejected:'1'};
}
export class FakeSupplier {
  readonly path:string;readonly mode:'accepted'|'partial'|'timeout_after_accept';readonly markerPath:string;
  private readonly owner=randomUUID();private readonly lockWaitMs:number;private readonly lockPollMs:number;
  private serial:Promise<unknown>=Promise.resolve();
  constructor(path:string,mode:'accepted'|'partial'|'timeout_after_accept'='partial',options:FakeSupplierOptions={}){
    // Validated before anything touches the filesystem: an unusable bound is a configuration fault, not a
    // condition to discover part way through an acquisition.
    this.lockWaitMs=boundedMilliseconds('lockWaitMs',options.lockWaitMs??2000);
    this.lockPollMs=boundedMilliseconds('lockPollMs',options.lockPollMs??10);
    this.path=path;this.mode=mode;this.markerPath=`${path}.lock`;
  }
  /** Exclusive-create is atomic for every independent instance and process sharing this ledger path.
   * A marker left by a crashed holder is never removed on age alone: the bounded wait ends in refusal,
   * so stale evidence survives for an operator decision instead of being silently taken over. */
  private async acquire():Promise<void>{
    // Elapsed time is measured on the monotonic high-resolution clock, so changing the wall clock cannot
    // extend or shorten the bound. Wall-clock time is recorded in the marker for diagnosis only.
    const started=process.hrtime.bigint();
    const elapsedMs=()=>Number(process.hrtime.bigint()-started)/1e6;
    await mkdir(dirname(this.path),{recursive:true});
    for(;;){
      try {
        const handle=await open(this.markerPath,'wx');let written=false;
        // Exclusive creation proves this marker is ours, so an unwritten one may be cleared here; that is
        // ownership, not a takeover, and it keeps a failed write from locking the ledger permanently.
        try {await handle.writeFile(JSON.stringify({owner:this.owner,pid:process.pid,acquiredAt:new Date().toISOString()} satisfies Marker));written=true;}
        finally {await handle.close();if(!written)await unlink(this.markerPath).catch(()=>undefined);}
        return;
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const remainingMs=this.lockWaitMs-elapsedMs();
        if(remainingMs<=0)throw new SupplierLedgerLockError(this.markerPath,this.lockWaitMs);
        // The final sleep never overshoots the bound, so the total wait stays within it plus one attempt.
        await delay(Math.min(this.lockPollMs,remainingMs));
      }
    }
  }
  private async release():Promise<void>{
    try {
      const marker=JSON.parse(await readFile(this.markerPath,'utf8')) as Partial<Marker>;
      // Only the recorded owner may clear the marker; a failure here leaves the ledger refused, never guessed.
      if(marker.owner===this.owner)await unlink(this.markerPath);
    } catch {/* a lost or unreadable marker is surfaced by the next bounded acquisition */}
  }
  private async withLock<T>(action:()=>Promise<T>):Promise<T>{
    await this.acquire();
    try {return await action();} finally {await this.release();}
  }
  private async read():Promise<Ledger>{
    try {return JSON.parse(await readFile(this.path,'utf8')) as Ledger;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {submitCalls:0,lookupCalls:0,orders:{}};throw error;}
  }
  /** A consistent snapshot: taken under the same exclusive access as a write, so a reader can never
   * observe a half-written ledger or block a concurrent replace. */
  async ledger():Promise<Ledger>{return this.serial.then(()=>this.withLock(()=>this.read()));}
  private change<T>(action:(ledger:Ledger)=>T):Promise<T>{
    const result=this.serial.then(()=>this.withLock(async()=>{
      const ledger=await this.read();const value=action(ledger);
      const temporary=`${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary,JSON.stringify(ledger));await rename(temporary,this.path);return value;
    }));this.serial=result.catch(()=>undefined);return result;
  }
  async submit(reference:string,lines:SupplierLine[]):Promise<Acknowledgement>{
    if(!reference.startsWith('pc-syn-')||!lines.length||lines.some(l=>!isPositiveDecimalString(l.quantity)))throw new Error('Invalid synthetic submission');
    const result=await this.change(ledger=>{
      ledger.submitCalls++;
      // The freshest ledger is read under exclusive access, so one reference keeps one external order
      // however many independent instances or processes submit it.
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
