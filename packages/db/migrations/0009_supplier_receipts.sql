ALTER TABLE quote ADD COLUMN pricing_rule_version text NOT NULL DEFAULT 'synthetic-cash-tax-exempt-v1';
CREATE TABLE order_line(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid NOT NULL,branch_id uuid NOT NULL,intent_id uuid NOT NULL,need_id uuid NOT NULL,
 product_snapshot jsonb NOT NULL,ordered numeric NOT NULL CHECK(ordered>0 AND ordered<1000000000000),
 accepted numeric NOT NULL DEFAULT 0,rejected numeric NOT NULL DEFAULT 0,shipped numeric NOT NULL DEFAULT 0,received numeric NOT NULL DEFAULT 0,
 CHECK(accepted>=0 AND rejected>=0 AND accepted+rejected<=ordered AND shipped>=0 AND shipped<=accepted AND received>=0 AND received<=shipped),
 UNIQUE(intent_id,need_id),FOREIGN KEY(organisation_id,branch_id,intent_id) REFERENCES order_intent(organisation_id,branch_id,id));
CREATE TABLE submission_attempt(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid NOT NULL,branch_id uuid NOT NULL,intent_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('started','unknown','acknowledged','rejected')),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organisation_id,branch_id,intent_id) REFERENCES order_intent(organisation_id,branch_id,id));
CREATE TABLE receipt(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,intent_id uuid NOT NULL,reference text NOT NULL,request_hash text NOT NULL,
 lines jsonb NOT NULL,UNIQUE(intent_id,reference),FOREIGN KEY(organisation_id,branch_id,intent_id) REFERENCES order_intent(organisation_id,branch_id,id));
CREATE TABLE receipt_writeback(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid NOT NULL,branch_id uuid NOT NULL,receipt_id uuid NOT NULL UNIQUE REFERENCES receipt(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','applied')),FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id));
DO $rls$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['order_line','submission_attempt','receipt','receipt_writeback'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id()) WITH CHECK(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())',table_name);
 END LOOP;
END $rls$;
GRANT SELECT,INSERT,UPDATE ON order_line,submission_attempt,receipt,receipt_writeback TO pharmacart_runtime;
