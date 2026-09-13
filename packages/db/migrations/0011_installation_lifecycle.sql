-- Persists the four installation states of docs/installation-lifecycle.md so the
-- authenticated request boundary can read current status instead of queue time.
ALTER TABLE connector_installation DROP CONSTRAINT connector_installation_status_check;
ALTER TABLE connector_installation ADD CONSTRAINT connector_installation_status_check
 CHECK(status IN ('pending','active','suspended','revoked'));
-- Rows created before this migration have no recorded pairing instant. Leave
-- paired_at NULL rather than invent one, and stamp their last status change with
-- an explicit legacy marker; rows created from here on stamp the real instant.
ALTER TABLE connector_installation
 ADD COLUMN paired_at timestamptz,
 ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT timestamptz '1970-01-01 00:00:00+00',
 ADD COLUMN status_reason text,
 ADD COLUMN supersedes_installation_id uuid REFERENCES connector_installation(id);
ALTER TABLE connector_installation ALTER COLUMN status_changed_at SET DEFAULT now();
ALTER TABLE connector_installation ADD CONSTRAINT connector_installation_supersedes_distinct
 CHECK(supersedes_installation_id IS DISTINCT FROM id);
COMMENT ON COLUMN connector_installation.paired_at IS 'Instant pairing was confirmed; NULL while pending and for rows predating 0011.';
COMMENT ON COLUMN connector_installation.status_changed_at IS 'Last status change; the 1970 epoch marks a row predating 0011.';
COMMENT ON COLUMN connector_installation.supersedes_installation_id IS 'Re-pairing mints a new identity and records the revoked one it replaces.';
-- Revocation is terminal. A resurrected identity would make every event ever
-- queued under it ambiguous, so the transition is refused in the database as
-- well as in the domain. Non-resurrecting maintenance of a revoked row is left
-- alone, which keeps administrative fixture setup of legal transitions working
-- without granting the runtime any write on this table.
CREATE FUNCTION pharmacart_reject_installation_resurrection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF NEW.status IS DISTINCT FROM 'revoked' THEN
  RAISE EXCEPTION 'installation revocation is terminal: %', OLD.id
   USING ERRCODE='check_violation', DETAIL='terminal_state',
         HINT='Re-pairing must mint a new installation identity that supersedes this one.';
 END IF;
 RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION pharmacart_reject_installation_resurrection() FROM PUBLIC;
CREATE TRIGGER connector_installation_terminal_revocation BEFORE UPDATE ON connector_installation
 FOR EACH ROW WHEN (OLD.status='revoked') EXECUTE FUNCTION pharmacart_reject_installation_resurrection();
-- Narrow lifecycle lookup: one authenticated subject, its own stored scope, and
-- nothing else. It supersedes pharmacart_active_installation, which hides status
-- behind an empty result. FOR SHARE serialises the request against a concurrent
-- status update so a revocation cannot commit underneath an accepted write; the
-- runtime keeps SELECT-only rights on the table, and the lock is taken with the
-- definer's privileges. Organisation verification remains part of the predicate.
CREATE FUNCTION pharmacart_installation_lifecycle(requested_subject text)
RETURNS TABLE(id uuid,organisation_id uuid,branch_id uuid,status text,paired_at timestamptz,
 status_changed_at timestamptz,status_reason text,supersedes_installation_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT i.id,i.organisation_id,i.branch_id,i.status,i.paired_at,i.status_changed_at,i.status_reason,i.supersedes_installation_id
 FROM public.connector_installation i
 WHERE i.user_subject=requested_subject
  AND EXISTS (SELECT 1 FROM public.organisation o WHERE o.id=i.organisation_id AND o.verification_status='verified')
 FOR SHARE OF i
$function$;
REVOKE ALL ON FUNCTION pharmacart_installation_lifecycle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pharmacart_installation_lifecycle(text) TO pharmacart_runtime;
