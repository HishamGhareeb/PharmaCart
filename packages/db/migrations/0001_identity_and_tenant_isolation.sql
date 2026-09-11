DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmacart_runtime') THEN
    CREATE ROLE pharmacart_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE pharmacart_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;

CREATE TABLE IF NOT EXISTS organisation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pharmacy', 'supplier')),
  name text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('unverified', 'verified', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (id, kind)
);

CREATE TABLE IF NOT EXISTS branch (
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  id uuid NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (organisation_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS branch_organisation_external_ref_key
  ON branch (organisation_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  user_subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'purchaser', 'receiver', 'supplier_operator', 'supplier_administrator', 'support')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organisation_id, user_subject),
  UNIQUE (organisation_id, id)
);

CREATE TABLE IF NOT EXISTS membership_branch (
  organisation_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (membership_id, branch_id),
  FOREIGN KEY (organisation_id, membership_id) REFERENCES membership(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, branch_id) REFERENCES branch(organisation_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS need (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_ref text NOT NULL,
  requested_quantity numeric NOT NULL CHECK (requested_quantity > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'quoted', 'covered', 'closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (organisation_id, branch_id) REFERENCES branch(organisation_id, id)
);

CREATE TABLE IF NOT EXISTS app_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_organisation_id uuid NOT NULL,
  pharmacy_organisation_kind text GENERATED ALWAYS AS ('pharmacy') STORED,
  pharmacy_branch_id uuid NOT NULL,
  supplier_organisation_id uuid NOT NULL,
  supplier_organisation_kind text GENERATED ALWAYS AS ('supplier') STORED,
  external_client_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'submitting', 'outcome_unknown', 'acknowledged', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (pharmacy_organisation_id, pharmacy_branch_id) REFERENCES branch(organisation_id, id),
  FOREIGN KEY (pharmacy_organisation_id, pharmacy_organisation_kind) REFERENCES organisation(id, kind),
  FOREIGN KEY (supplier_organisation_id, supplier_organisation_kind) REFERENCES organisation(id, kind),
  CHECK (pharmacy_organisation_id <> supplier_organisation_id),
  UNIQUE (pharmacy_organisation_id, supplier_organisation_id, external_client_ref)
);

CREATE OR REPLACE FUNCTION pharmacart_current_organisation_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN nullif(current_setting('app.organisation_id', true), '')::uuid;

CREATE OR REPLACE FUNCTION pharmacart_current_branch_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN nullif(current_setting('app.branch_id', true), '')::uuid;

ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
ALTER TABLE branch ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch FORCE ROW LEVEL SECURITY;
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_branch ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_branch FORCE ROW LEVEL SECURITY;
ALTER TABLE need ENABLE ROW LEVEL SECURITY;
ALTER TABLE need FORCE ROW LEVEL SECURITY;
ALTER TABLE app_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organisation_tenant_policy ON organisation;
CREATE POLICY organisation_tenant_policy ON organisation
  USING (id = pharmacart_current_organisation_id())
  WITH CHECK (id = pharmacart_current_organisation_id());

DROP POLICY IF EXISTS branch_tenant_policy ON branch;
CREATE POLICY branch_tenant_policy ON branch
  USING (organisation_id = pharmacart_current_organisation_id() AND id = pharmacart_current_branch_id())
  WITH CHECK (organisation_id = pharmacart_current_organisation_id() AND id = pharmacart_current_branch_id());

DROP POLICY IF EXISTS membership_tenant_policy ON membership;
CREATE POLICY membership_tenant_policy ON membership
  USING (
    organisation_id = pharmacart_current_organisation_id()
    AND EXISTS (
      SELECT 1 FROM membership_branch scope
      WHERE scope.organisation_id = membership.organisation_id
        AND scope.membership_id = membership.id
        AND scope.branch_id = pharmacart_current_branch_id()
    )
  )
  WITH CHECK (
    organisation_id = pharmacart_current_organisation_id()
  );

DROP POLICY IF EXISTS membership_branch_tenant_policy ON membership_branch;
CREATE POLICY membership_branch_tenant_policy ON membership_branch
  USING (
    organisation_id = pharmacart_current_organisation_id()
    AND branch_id = pharmacart_current_branch_id()
  )
  WITH CHECK (
    organisation_id = pharmacart_current_organisation_id()
    AND branch_id = pharmacart_current_branch_id()
  );

DROP POLICY IF EXISTS need_tenant_branch_policy ON need;
CREATE POLICY need_tenant_branch_policy ON need
  USING (
    organisation_id = pharmacart_current_organisation_id()
    AND branch_id = pharmacart_current_branch_id()
  )
  WITH CHECK (
    organisation_id = pharmacart_current_organisation_id()
    AND branch_id = pharmacart_current_branch_id()
  );

DROP POLICY IF EXISTS order_party_policy ON app_order;
CREATE POLICY order_party_policy ON app_order
  FOR SELECT USING (
    (
      supplier_organisation_id = pharmacart_current_organisation_id()
      AND pharmacy_branch_id = pharmacart_current_branch_id()
    )
    OR (
      pharmacy_organisation_id = pharmacart_current_organisation_id()
      AND pharmacy_branch_id = pharmacart_current_branch_id()
    )
  );

DROP POLICY IF EXISTS order_pharmacy_insert_policy ON app_order;
CREATE POLICY order_pharmacy_insert_policy ON app_order
  FOR INSERT WITH CHECK (
    pharmacy_organisation_id = pharmacart_current_organisation_id()
    AND pharmacy_branch_id = pharmacart_current_branch_id()
  );

REVOKE ALL ON organisation, branch, membership, membership_branch, need, app_order FROM PUBLIC;
REVOKE ALL ON FUNCTION pharmacart_current_organisation_id(), pharmacart_current_branch_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pharmacart_current_organisation_id(), pharmacart_current_branch_id() TO pharmacart_runtime;
GRANT SELECT ON organisation, branch, membership, membership_branch TO pharmacart_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON need TO pharmacart_runtime;
GRANT SELECT, INSERT ON app_order TO pharmacart_runtime;
