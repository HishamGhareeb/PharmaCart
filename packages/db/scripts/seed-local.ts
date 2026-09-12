import { psql } from './postgres.mjs';
import { createSyntheticFixtureSet } from '../../test-fixtures/src/index.ts';

// Development-only inserts. Re-running never resets approvals, reservations, credentials or revocations.
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const a='10000000-0000-4000-8000-000000000001';
const b='10000000-0000-4000-8000-000000000002';
const supplier='10000000-0000-4000-8000-000000000003';
const branchA='20000000-0000-4000-8000-000000000001';
const branchB='20000000-0000-4000-8000-000000000002';
const member='30000000-0000-4000-8000-000000000001';
const product=createSyntheticFixtureSet().products[0]!;
const catalogue=createSyntheticFixtureSet().products.map(p=>{
  const [value,...unit]=p.packSize.split(' ');
  return `(${quote(p.id)},${quote(JSON.stringify({brand:p.brand,manufacturer:p.manufacturer,strength:p.strength,dosageForm:p.dosageForm,packSize:{value,unit:unit.join(' ')},saleUnit:'box'}))},'verified')`;
}).join(',');
await psql('pharmacart',`BEGIN;
 INSERT INTO organisation(id,kind,name,verification_status) VALUES('${a}','pharmacy','Synthetic A','verified'),('${b}','pharmacy','Synthetic B','verified'),('${supplier}','supplier','Synthetic Supplier','verified') ON CONFLICT DO NOTHING;
 INSERT INTO branch(id,organisation_id,name,timezone) VALUES('${branchA}','${a}','Synthetic A','Asia/Bahrain'),('${branchB}','${b}','Synthetic B','Asia/Bahrain') ON CONFLICT DO NOTHING;
 WITH inserted AS (INSERT INTO membership(id,organisation_id,user_subject,role,status) VALUES('${member}','${a}','synthetic:user:a','pharmacy_owner','active'),('30000000-0000-4000-8000-000000000002','${b}','synthetic:user:b','purchaser','active') ON CONFLICT DO NOTHING RETURNING id,organisation_id)
 INSERT INTO membership_branch SELECT organisation_id,id,CASE WHEN organisation_id='${a}'::uuid THEN '${branchA}'::uuid ELSE '${branchB}'::uuid END FROM inserted;
 INSERT INTO procurement_product(id,identity,status) VALUES ${catalogue} ON CONFLICT DO NOTHING;
 INSERT INTO source_product_map(id,organisation_id,branch_id,product_id,status,version) VALUES('70000000-0000-4000-8000-000000000001','${a}','${branchA}','${product.id}','verified',1) ON CONFLICT DO NOTHING;
 INSERT INTO need(id,organisation_id,branch_id,product_ref,requested_quantity,source_map_id) VALUES('40000000-0000-4000-8000-000000000001','${a}','${branchA}','${product.id}',2,'70000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
 INSERT INTO supplier_relationship(id,organisation_id,branch_id,supplier_id,status,terms_version) VALUES('80000000-0000-4000-8000-000000000001','${a}','${branchA}','${supplier}','active',1) ON CONFLICT DO NOTHING;
 INSERT INTO account_offer(id,organisation_id,branch_id,relationship_id,product_id,unit,unit_price,currency,version,terms_version,expires_at) VALUES('90000000-0000-4000-8000-000000000001','${a}','${branchA}','80000000-0000-4000-8000-000000000001','${product.id}','box',12.35,'EGP',1,1,now()+interval '1 day') ON CONFLICT DO NOTHING;
 INSERT INTO budget(organisation_id,branch_id,currency,period,limit_amount,reserved_amount) VALUES('${a}','${branchA}','EGP',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),100,0) ON CONFLICT DO NOTHING;
 INSERT INTO connector_installation(id,organisation_id,branch_id,user_subject,status) VALUES('50000000-0000-4000-8000-000000000001','${a}','${branchA}','synthetic:connector:a','active') ON CONFLICT DO NOTHING;
 COMMIT;`);
process.stdout.write('Synthetic development fixtures inserted; existing state preserved.\n');
