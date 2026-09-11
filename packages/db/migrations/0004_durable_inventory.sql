CREATE TABLE connector_installation (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 user_subject text NOT NULL UNIQUE, status text NOT NULL CHECK(status IN ('active','revoked')),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id),
 UNIQUE(id,organisation_id,branch_id)
);
CREATE TABLE inventory_state (
 installation_id uuid PRIMARY KEY, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 state jsonb NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
CREATE TABLE inventory_inbox (
 installation_id uuid NOT NULL, event_id text NOT NULL, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 payload jsonb NOT NULL, processing_status text NOT NULL CHECK(processing_status='processed'),
 received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(installation_id,event_id),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
CREATE TABLE inventory_projection (
 installation_id uuid NOT NULL, source_code text NOT NULL, organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0 AND quantity NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
 unit text NOT NULL, stale boolean NOT NULL, snapshot_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 PRIMARY KEY(installation_id,source_code),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
-- Durable episode identities are reserved here; notifications and need generation are later stages.
CREATE TABLE inventory_alert (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 source_ref text NOT NULL, UNIQUE(organisation_id,source_ref),
 FOREIGN KEY(organisation_id,branch_id) REFERENCES branch(organisation_id,id)
);
DO $rls$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['connector_installation','inventory_state','inventory_inbox','inventory_projection','inventory_alert'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id()) WITH CHECK (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())',table_name);
 END LOOP;
END $rls$;
GRANT SELECT ON connector_installation TO pharmacart_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON inventory_state,inventory_inbox,inventory_projection,inventory_alert TO pharmacart_runtime;
CREATE FUNCTION pharmacart_active_installation(requested_subject text)
RETURNS TABLE(id uuid,organisation_id uuid,branch_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT i.id,i.organisation_id,i.branch_id FROM public.connector_installation i
 JOIN public.organisation o ON o.id=i.organisation_id
 WHERE i.user_subject=requested_subject AND i.status='active' AND o.verification_status='verified'
$function$;
REVOKE ALL ON FUNCTION pharmacart_active_installation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pharmacart_active_installation(text) TO pharmacart_runtime;
