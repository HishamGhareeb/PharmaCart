ALTER TABLE need ADD CONSTRAINT need_finite_quantity
  CHECK (requested_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

ALTER TABLE membership DROP CONSTRAINT membership_role_check;
UPDATE membership SET role = 'pharmacy_owner' WHERE role = 'owner';
ALTER TABLE membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('pharmacy_owner', 'purchaser', 'receiver', 'supplier_operator', 'supplier_administrator', 'support'));

-- No sequence permissions are required by UUID-backed domain entities.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM pharmacart_runtime;
