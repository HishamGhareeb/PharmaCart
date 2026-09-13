import type { Pool } from 'pg';
import { applyInventorySnapshotEvent, emptyInventorySnapshotState, type InventorySnapshotEvent, type InventorySnapshotState } from '../../domain/src/inventory-snapshot.ts';
import { loadInstallation, refuseInstallation, type InstallationRefusal } from './installation.ts';

export class InventoryError extends Error {
  readonly code: string;
  /** Stored status and sync directive behind an INSTALLATION_DENIED; null otherwise. */
  readonly refusal: InstallationRefusal | null;
  constructor(code: string, refusal: InstallationRefusal | null = null) { super(code); this.code=code; this.refusal=refusal; }
}
export type InventoryCommand = Omit<Extract<InventorySnapshotEvent,{kind:'partition'}>,'installationId'> | Omit<Extract<InventorySnapshotEvent,{kind:'complete'}>,'installationId'>;
export async function ingestInventory(pool: Pool, subject: string, command: InventoryCommand) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE pharmacart_runtime');
    // Authorisation reads current stored status, never the queue time of the event,
    // and happens before any inbox or projection write. The lookup takes a row
    // share lock, so a concurrent status update cannot commit underneath it.
    const installation = await loadInstallation(client,subject);
    const refusal = refuseInstallation(installation,'submit_inventory');
    if (refusal||!installation) throw new InventoryError('INSTALLATION_DENIED',refusal);
    await client.query("SELECT set_config('app.organisation_id',$1,true),set_config('app.branch_id',$2,true)",[installation.organisationId,installation.branchId]);
    const installationId=installation.installationId;
    const scope=[installationId,installation.organisationId,installation.branchId];
    await client.query('INSERT INTO inventory_state(installation_id,organisation_id,branch_id,state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,emptyInventorySnapshotState()]);
    const locked = await client.query<{state:string}>('SELECT state FROM inventory_state WHERE installation_id=$1 FOR UPDATE',[installationId]);
    // Recheck the lifecycle after waiting for the per-installation lock: a status
    // update may have committed while this request queued behind an earlier one.
    const current = refuseInstallation(await loadInstallation(client,subject),'submit_inventory');
    if (current) throw new InventoryError('INSTALLATION_DENIED',current);
    const state = JSON.parse(locked.rows[0]!.state) as InventorySnapshotState;
    const result = applyInventorySnapshotEvent(state,{...command,installationId});
    if (result.kind==='rejected') throw new InventoryError(result.reason);
    if (result.kind==='accepted') {
      await client.query("INSERT INTO inventory_inbox(installation_id,organisation_id,branch_id,event_id,payload,processing_status) VALUES($1,$2,$3,$4,$5,'processed')",[...scope,command.eventId,command]);
      await client.query('UPDATE inventory_state SET state=$2,revision=$3 WHERE installation_id=$1',[installationId,result.state,result.state.projectionRevision]);
      await client.query('DELETE FROM inventory_projection WHERE installation_id=$1',[installationId]);
      for(const row of Object.values(result.state.projections[installationId]??{})) {
        await client.query('INSERT INTO inventory_projection(installation_id,organisation_id,branch_id,source_code,quantity,unit,stale,snapshot_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...scope,row.sourceCode,row.quantity,row.unit,row.stale,row.snapshotId,row.sequence]);
      }
      if(result.state.projectionRevision>state.projectionRevision) {
        await client.query(`INSERT INTO need(organisation_id,branch_id,product_ref,requested_quantity,source_ref)
          SELECT t.organisation_id,t.branch_id,t.product_ref,t.target_quantity-p.quantity,t.installation_id::text || ':' || t.source_code
          FROM inventory_target t JOIN inventory_projection p USING(installation_id,source_code)
          WHERE t.installation_id=$1 AND NOT p.stale AND p.unit=t.unit AND p.quantity<t.target_quantity
          ON CONFLICT(organisation_id,source_ref) DO UPDATE SET requested_quantity=EXCLUDED.requested_quantity,version=need.version+1
          WHERE need.status='open' AND need.requested_quantity<>EXCLUDED.requested_quantity`,[installationId]);
        await client.query(`INSERT INTO inventory_alert(organisation_id,branch_id,source_ref)
          SELECT t.organisation_id,t.branch_id,t.installation_id::text || ':' || t.source_code
          FROM inventory_target t JOIN inventory_projection p USING(installation_id,source_code)
          WHERE t.installation_id=$1 AND NOT p.stale AND p.unit=t.unit AND p.quantity<t.target_quantity
          ON CONFLICT(organisation_id,source_ref) DO NOTHING`,[installationId]);
      }
    }
    await client.query('COMMIT');
    return {eventId:command.eventId,status:'processed',duplicate:result.kind==='duplicate',projectionRevision:result.state.projectionRevision};
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}
