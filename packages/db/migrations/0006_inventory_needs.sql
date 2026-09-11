ALTER TABLE need ADD COLUMN source_ref text;
ALTER TABLE need ADD CONSTRAINT need_source_identity UNIQUE(organisation_id,source_ref);
CREATE TABLE inventory_target (
 installation_id uuid NOT NULL,organisation_id uuid NOT NULL,branch_id uuid NOT NULL,
 source_code text NOT NULL,product_ref text NOT NULL,unit text NOT NULL,
 target_quantity numeric NOT NULL CHECK(target_quantity>0 AND target_quantity NOT IN ('NaN'::numeric,'Infinity'::numeric)),
 PRIMARY KEY(installation_id,source_code),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
ALTER TABLE inventory_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_target FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_target USING(organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id());
GRANT SELECT ON inventory_target TO pharmacart_runtime;
