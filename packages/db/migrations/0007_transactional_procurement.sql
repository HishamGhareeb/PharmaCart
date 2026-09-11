CREATE DOMAIN commercial_amount AS numeric CHECK(VALUE>=0 AND VALUE<=1000000000000000 AND VALUE=round(VALUE,2));
CREATE TABLE procurement_product(id uuid PRIMARY KEY,identity jsonb NOT NULL,status text NOT NULL CHECK(status IN ('verified','review')));
CREATE TABLE source_product_map(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,
 product_id uuid REFERENCES procurement_product(id),status text NOT NULL CHECK(status IN ('verified','review')),version integer NOT NULL CHECK(version>0),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id),UNIQUE(organisation_id,branch_id,id));
ALTER TABLE need ADD COLUMN source_map_id uuid;
ALTER TABLE need ADD FOREIGN KEY(organisation_id,branch_id,source_map_id) REFERENCES source_product_map(organisation_id,branch_id,id);
CREATE TABLE supplier_relationship(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,supplier_id uuid NOT NULL REFERENCES organisation(id),
 status text NOT NULL CHECK(status IN ('active','revoked')),terms_version integer NOT NULL CHECK(terms_version>0),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id),UNIQUE(organisation_id,branch_id,id));
CREATE TABLE account_offer(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,relationship_id uuid NOT NULL,
 product_id uuid NOT NULL REFERENCES procurement_product(id),unit text NOT NULL,unit_price commercial_amount NOT NULL CHECK(unit_price>0),
 currency text NOT NULL CHECK(currency='EGP'),version integer NOT NULL CHECK(version>0),terms_version integer NOT NULL CHECK(terms_version>0),expires_at timestamptz NOT NULL,
 available_quantity numeric NOT NULL DEFAULT 1000 CHECK(available_quantity>=0 AND available_quantity<1000000000000),
 FOREIGN KEY(organisation_id,branch_id,relationship_id) REFERENCES supplier_relationship(organisation_id,branch_id,id));
CREATE TABLE quote(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('quoted','approved')),total commercial_amount NOT NULL,currency text NOT NULL CHECK(currency='EGP'),
 expires_at timestamptz NOT NULL,terms_hash text NOT NULL,lines jsonb NOT NULL,
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id),UNIQUE(organisation_id,branch_id,id));
CREATE TABLE budget(organisation_id uuid NOT NULL,branch_id uuid NOT NULL,currency text NOT NULL,period text NOT NULL,
 limit_amount commercial_amount NOT NULL,reserved_amount commercial_amount NOT NULL CHECK(reserved_amount<=limit_amount),
 PRIMARY KEY(organisation_id,branch_id,currency,period),FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id));
CREATE TABLE approval(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,quote_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organisation_id,branch_id,quote_id) REFERENCES quote(organisation_id,branch_id,id),FOREIGN KEY(organisation_id,actor_id) REFERENCES membership(organisation_id,id));
CREATE TABLE budget_reservation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid NOT NULL,branch_id uuid NOT NULL,quote_id uuid NOT NULL UNIQUE,
 amount commercial_amount NOT NULL,currency text NOT NULL,period text NOT NULL,status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','released')),
 FOREIGN KEY(organisation_id,branch_id,quote_id) REFERENCES quote(organisation_id,branch_id,id),
 FOREIGN KEY(organisation_id,branch_id,currency,period) REFERENCES budget(organisation_id,branch_id,currency,period));
CREATE TABLE order_intent(id uuid PRIMARY KEY,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,quote_id uuid NOT NULL,
 supplier_id uuid NOT NULL REFERENCES organisation(id),external_client_ref text NOT NULL UNIQUE,state text NOT NULL CHECK(state IN ('queued','submitting','outcome_unknown','acknowledged','rejected','human_review')),
 version integer NOT NULL DEFAULT 1,external_order_id text,UNIQUE(quote_id,supplier_id),
 FOREIGN KEY(organisation_id,branch_id,quote_id) REFERENCES quote(organisation_id,branch_id,id),UNIQUE(organisation_id,branch_id,id));
CREATE TABLE procurement_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid NOT NULL,branch_id uuid NOT NULL,
 aggregate_id uuid NOT NULL,event_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,UNIQUE(aggregate_id,event_type),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id));
CREATE TABLE command_result(organisation_id uuid NOT NULL,branch_id uuid NOT NULL,operation text NOT NULL,key text NOT NULL,
 request_hash text NOT NULL,status integer NOT NULL,body jsonb NOT NULL,PRIMARY KEY(organisation_id,operation,key),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id));
DO $rls$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['source_product_map','supplier_relationship','account_offer','quote','budget','approval','budget_reservation','order_intent','procurement_outbox','command_result'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id()) WITH CHECK(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())',table_name);
 END LOOP;
END $rls$;
GRANT SELECT ON procurement_product,source_product_map,supplier_relationship,account_offer TO pharmacart_runtime;
GRANT SELECT,INSERT,UPDATE ON quote,budget,approval,budget_reservation,order_intent,procurement_outbox,command_result TO pharmacart_runtime;
