-- Commitment-aware need recalculation needs two durable facts that neither the projection nor the
-- order tables carry today.
--
-- The first is that the outstanding remainder of a need could not be proven at the last recalculation,
-- and why. Without it, a recalculation that meets an order of unknown quantity has only two bad
-- options. It can guess a quantity, which either double-orders or under-orders depending on which way
-- it guesses, or it can leave the need looking ordinary, in which case the next quote proceeds on a
-- number nobody proved. Recording the refusal instead keeps the need visible, keeps the rest of the
-- installation moving, and gives the commercial path something explicit to refuse on.
ALTER TABLE need ADD COLUMN hold_reason text;

-- The four reasons are closed on purpose. A hold is a refusal to act, so an unrecognised one would be a
-- refusal nobody can clear; a new reason must arrive with the code that resolves it.
ALTER TABLE need ADD CONSTRAINT need_hold_reason_known
 CHECK (hold_reason IS NULL OR hold_reason IN
  ('unknown_order_state','receipt_inclusion_unproven','commitment_unit_mismatch','unverified_commitment'));

COMMENT ON COLUMN need.hold_reason IS
 'Null while the outstanding remainder is proven. Otherwise the reason the last reconciliation refused to recompute it: unknown_order_state when an order affecting this need is submitting, outcome_unknown or in human review, so its committed quantity is not knowable; receipt_inclusion_unproven when a confirmed receipt cannot be shown to be reflected in the observed stock; commitment_unit_mismatch when a commitment is denominated in a unit the target cannot be compared against without inventing a pack agreement; unverified_commitment when an order line, quoted quantity or intent state could not be read as a commitment at all. The column is a cache of the last recalculation, not the authority: quoting and approval also read current order state, because an order can become unknown after a feed and before the next quote.';

-- The second fact is which observation first carried a receipt back into stock.
--
-- receipt_writeback.status already distinguishes a receipt still queued for writeback from one whose
-- writeback has been delivered, and it is tempting to read 'applied' as "the stock system now knows".
-- It is not. Delivery to the source system says nothing about which export ran afterwards, and the
-- snapshot this installation is comparing against may have been taken before, during or after that
-- write landed. Treating 'applied' as inclusion would count the received boxes twice on one side of
-- that race and treat them as never arriving on the other.
--
-- So inclusion is recorded positively or not at all: the snapshot identity and sequence at which the
-- received stock is known to appear. Reconciliation lifts its hold only once the installation has
-- observed a fresh snapshot at or beyond that sequence. Nothing writes these columns yet, and that is
-- the accurate state of the system rather than a gap to paper over: until the writeback path can prove
-- inclusion, every receipt holds the need it touched, and no replenishment is guessed.
ALTER TABLE receipt_writeback
 ADD COLUMN included_snapshot_id text,
 ADD COLUMN included_sequence bigint;

-- A sequence without the snapshot that produced it, or the reverse, is half an answer; either would let
-- a partial write lift a hold that the complete evidence would not.
ALTER TABLE receipt_writeback ADD CONSTRAINT receipt_writeback_inclusion_complete
 CHECK ((included_snapshot_id IS NULL) = (included_sequence IS NULL));
ALTER TABLE receipt_writeback ADD CONSTRAINT receipt_writeback_inclusion_positive
 CHECK (included_sequence IS NULL OR included_sequence > 0);
-- Inclusion cannot precede the delivery that causes it.
ALTER TABLE receipt_writeback ADD CONSTRAINT receipt_writeback_inclusion_applied
 CHECK (included_snapshot_id IS NULL OR status = 'applied');

COMMENT ON COLUMN receipt_writeback.included_snapshot_id IS
 'Snapshot this receipt is known to be reflected in, or NULL while that is unproven. An applied writeback is delivery evidence only: it does not establish that any later snapshot already carried the received stock.';
COMMENT ON COLUMN receipt_writeback.included_sequence IS
 'Sequence of the including snapshot. Reconciliation treats the receipt as reflected in stock only once a fresh, matching-unit projection at or beyond this sequence has been observed for the affected source code.';

-- No grant changes: both tables already carry the runtime privileges these columns inherit.
