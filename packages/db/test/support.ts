import { applyMigrations, ensureTestDatabase, psql } from '../scripts/postgres.mjs';
import { configureRuntimeLogin } from '../scripts/runtime-setup.mjs';
import { createRuntimePool } from '../src/runtime.ts';
export const ids = {
  a: '10000000-0000-4000-8000-000000000001', b: '10000000-0000-4000-8000-000000000002',
  supplier: '10000000-0000-4000-8000-000000000003',
  branchA: '20000000-0000-4000-8000-000000000001', branchB: '20000000-0000-4000-8000-000000000002',
  memberA: '30000000-0000-4000-8000-000000000001', memberB: '30000000-0000-4000-8000-000000000002',
  needA: '40000000-0000-4000-8000-000000000001', needB: '40000000-0000-4000-8000-000000000002',
  installation: '50000000-0000-4000-8000-000000000001',
};
export const sql = (text: string) => psql('pharmacart_test', text);
export async function resetDatabase() {
  await ensureTestDatabase(); await applyMigrations('pharmacart_test');
  await sql(`TRUNCATE organisation,procurement_product CASCADE;
    INSERT INTO organisation(id,kind,name,verification_status) VALUES
    ('${ids.a}','pharmacy','Synthetic A','verified'),('${ids.b}','pharmacy','Synthetic B','verified'),
    ('${ids.supplier}','supplier','Synthetic Supplier','verified');
    INSERT INTO branch(id,organisation_id,name,timezone) VALUES
    ('${ids.branchA}','${ids.a}','A','Asia/Bahrain'),('${ids.branchB}','${ids.b}','B','Asia/Bahrain');
    INSERT INTO membership(id,organisation_id,user_subject,role,status) VALUES
    ('${ids.memberA}','${ids.a}','synthetic:user:a','pharmacy_owner','active'),
    ('${ids.memberB}','${ids.b}','synthetic:user:b','purchaser','active');
    INSERT INTO membership_branch VALUES ('${ids.a}','${ids.memberA}','${ids.branchA}'),('${ids.b}','${ids.memberB}','${ids.branchB}');
    INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity) VALUES
    ('${ids.needA}','${ids.a}','${ids.branchA}','SYN-A',2),('${ids.needB}','${ids.b}','${ids.branchB}','SYN-B-PRIVATE',3);`);
  const { connectionString } = await configureRuntimeLogin('pharmacart_test');
  return createRuntimePool({ connectionString, max: 4 });
}
