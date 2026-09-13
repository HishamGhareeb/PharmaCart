-- Records the meaning of two procurement invariants next to the constraints that enforce them.
-- Comments only: no table, column, constraint, policy or grant changes, so application behaviour
-- does not depend on this migration being applied.

COMMENT ON COLUMN need.requested_quantity IS
 'Outstanding quantity still to procure while status is open. Approving a quote subtracts exactly the quoted quantity and increments version by one; a positive remainder stays open and invalidates any competing quote that captured the earlier version. The column must stay positive, so a need that is covered exactly keeps the quantity of its final covered tranche instead of zero. Read outstanding demand as requested_quantity when the status is open and as zero when the status is covered or closed.';

COMMENT ON COLUMN need.status IS
 'open means requested_quantity is still outstanding; covered means an approval consumed the whole outstanding quantity and requested_quantity is frozen at the last covered tranche; closed means the need was retired without procurement.';

COMMENT ON TABLE command_result IS
 'Stored idempotent command results. The primary key (organisation_id, operation, key) is organisation-wide while the row level security policy restricts visibility to the current branch, so a key already recorded by another branch of the same organisation is invisible to a replay read. Approval therefore inserts with ON CONFLICT DO NOTHING and refuses the reused key with 409 IDEMPOTENCY_KEY_SCOPE_CONFLICT rather than raising a unique violation, overwriting the stored result, or disclosing the other branch.';

COMMENT ON COLUMN command_result.branch_id IS
 'Branch that recorded the result. It is not part of the key: it scopes visibility and never widens the organisation-wide key namespace.';
