import type { Pool } from 'pg';
import { applyInventorySnapshotEvent, emptyInventorySnapshotState, type InventorySnapshotEvent, type InventorySnapshotState } from '../../domain/src/inventory-snapshot.ts';

export class InventoryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code=code; }
}
export type InventoryCommand = Omit<Extract<InventorySnapshotEvent,{kind:'partition'}>,'installationId'> | Omit<Extract<InventorySnapshotEvent,{kind:'complete'}>,'installationId'>;
export async function ingestInventory(pool: Pool, subject: string, command: InventoryCommand) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE pharmacart_runtime');
    const lookup = await client.query<{id:string;organisation_id:string;branch_id:string}>('SELECT * FROM pharmacart_active_installation($1)',[subject]);
    const installation = lookup.rows[0];
    if (!installation) throw new InventoryError('INSTALLATION_DENIED');
    await client.query("SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)",[installation.organisation_id,installation.branch_id]);
    const scope=[installation.id,installation.organisation_id,installation.branch_id];
    await client.query('INSERT INTO inventory_state(installation_id,organisation_id,branch_id,state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,emptyInventorySnapshotState()]);
    const locked = await client.query<{state:string}>('SELECT state FROM inventory_state WHERE installation_id=$1 FOR UPDATE',[installation.id]);
    // Recheck revocation after waiting for the per-installation lock.
    if (!(await client.query('SELECT * FROM pharmacart_active_installation($1)',[subject])).rowCount) throw new InventoryError('INSTALLATION_DENIED');
    const state = JSON.parse(locked.rows[0]!.state) as InventorySnapshotState;
    const result = applyInventorySnapshotEvent(state,{...command,installationId:installation.id});
    if (result.kind==='rejected') throw new InventoryError(result.reason);
    if (result.kind==='accepted') {
      await client.query("INSERT INTO inventory_inbox(installation_id,organisation_id,branch_id,event_id,payload,processing_status) VALUES($1,$2,$3,$4,$5,'processed')",[...scope,command.eventId,command]);
      await client.query('UPDATE inventory_state SET state=$2,revision=$3 WHERE installation_id=$1',[installation.id,result.state,result.state.projectionRevision]);
      await client.query('DELETE FROM inventory_projection WHERE installation_id=$1',[installation.id]);
      for(const row of Object.values(result.state.projections[installation.id]??{})) {
        await client.query('INSERT INTO inventory_projection(installation_id,organisation_id,branch_id,source_code,quantity,unit,stale,snapshot_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...scope,row.sourceCode,row.quantity,row.unit,row.stale,row.snapshotId,row.sequence]);
      }
      if(result.state.projectionRevision>state.projectionRevision) {
        await client.query(`INSERT INTO need(organisation_id,branch_id,product_ref,requested_quantity,source_ref)
          SELECT t.organisation_id,t.branch_id,t.product_ref,t.target_quantity-p.quantity,t.installation_id::text || ':' || t.source_code
          FROM inventory_target t JOIN inventory_projection p USING(installation_id,source_code)
          WHERE t.installation_id=$1 AND NOT p.stale AND p.unit=t.unit AND p.quantity<t.target_quantity
          ON CONFLICT(organisation_id,source_ref) DO UPDATE SET requested_quantity=EXCLUDED.requested_quantity,version=need.version+1
          WHERE need.status='open' AND need.requested_quantity<>EXCLUDED.requested_quantity`,[installation.id]);
        await client.query(`INSERT INTO inventory_alert(organisation_id,branch_id,source_ref)
          SELECT t.organisation_id,t.branch_id,t.installation_id::text || ':' || t.source_code
          FROM inventory_target t JOIN inventory_projection p USING(installation_id,source_code)
          WHERE t.installation_id=$1 AND NOT p.stale AND p.unit=t.unit AND p.quantity<t.target_quantity
          ON CONFLICT(organisation_id,source_ref) DO NOTHING`,[installation.id]);
      }
    }
    await client.query('COMMIT');
    return {eventId:command.eventId,status:'processed',duplicate:result.kind==='duplicate',projectionRevision:result.state.projectionRevision};
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}
