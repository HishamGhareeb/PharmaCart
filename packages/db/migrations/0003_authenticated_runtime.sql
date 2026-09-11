DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pharmacart_app') THEN
    CREATE ROLE pharmacart_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE pharmacart_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;

GRANT pharmacart_runtime TO pharmacart_app;

ALTER TABLE membership ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE OR REPLACE FUNCTION pharmacart_active_membership(
  requested_subject text,
  requested_organisation_id uuid,
  requested_branch_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  organisation_kind text,
  membership_role text,
  membership_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT member.id, organisation.kind, member.role, member.version
  FROM public.membership AS member
  JOIN public.organisation AS organisation
    ON organisation.id = member.organisation_id
  JOIN public.membership_branch AS scope
    ON scope.organisation_id = member.organisation_id
   AND scope.membership_id = member.id
  WHERE member.user_subject = requested_subject
    AND member.organisation_id = requested_organisation_id
    AND scope.branch_id = requested_branch_id
    AND member.status = 'active'
$function$;

REVOKE ALL ON FUNCTION pharmacart_active_membership(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pharmacart_active_membership(text, uuid, uuid) TO pharmacart_runtime;

