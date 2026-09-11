import { ids, sql } from './support.ts';
export async function seedProcurement() {
  await sql(`INSERT INTO procurement_product(id,identity,status) VALUES
    ('60000000-0000-4000-8000-000000000001','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"5 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','verified'),
    ('60000000-0000-4000-8000-000000000002','{"brand":"SYN Brand","manufacturer":"SYN Maker","strength":"10 mg","dosageForm":"tablet","packSize":{"value":"20","unit":"tablet"},"saleUnit":"box"}','verified');
    INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES
    ('70000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','60000000-0000-4000-8000-000000000001','verified',1);
    UPDATE need SET source_map_id='70000000-0000-4000-8000-000000000001' WHERE id='${ids.needA}';
    INSERT INTO supplier_relationship(id,organisation_id,branch_id,supplier_id,status,terms_version) VALUES
    ('80000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','${ids.supplier}','active',1);
    INSERT INTO account_offer(id,organisation_id,branch_id,relationship_id,product_id,unit,unit_price,currency,version,terms_version,expires_at) VALUES
    ('90000000-0000-4000-8000-000000000001','${ids.a}','${ids.branchA}','80000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','box',12.35,'EGP',1,1,now()+interval '1 hour');
    INSERT INTO budget(organisation_id,branch_id,currency,period,limit_amount,reserved_amount) VALUES
    ('${ids.a}','${ids.branchA}','EGP',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),100,0);`);
}
