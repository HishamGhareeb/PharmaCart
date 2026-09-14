-- Scoped feed identity at one-second resolution.
--
-- packages/feed-identity derives a snapshot sequence from the export's own
-- timestamp as whole seconds, which is what makes re-reading a dropped file a
-- duplicate rather than a second delivery. docs/feed-identity.md, section 4
-- records the cost of that resolution: two exports from one installation within
-- the same second collapse to one sequence, and the current design would
-- silently mis-handle differing contents rather than refuse them. Same batch and
-- partition reaches the reducer as a conflicting partition, but a second export
-- under a different batch key mints a fresh snapshot identity and is refused
-- only incidentally, as a stale sequence, which names the wrong problem.
--
-- This table makes the collapse an explicit, named refusal. Every accepted feed
-- records what it was against the second it claimed, so a later transaction can
-- see that the second is already spoken for and by what. The identity is scoped
-- to the installation: two pharmacies exporting in the same second are
-- unrelated and must not contend.
CREATE TABLE feed_sequence_identity (
 installation_id uuid NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 batch_key text NOT NULL CHECK(length(batch_key) BETWEEN 1 AND 256),
 partition_key text NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 256),
 organisation_id uuid NOT NULL, branch_id uuid NOT NULL,
 content_digest text NOT NULL, snapshot_id text NOT NULL, event_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,sequence,batch_key,partition_key),
 FOREIGN KEY(installation_id,organisation_id,branch_id) REFERENCES connector_installation(id,organisation_id,branch_id)
);
ALTER TABLE feed_sequence_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_sequence_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON feed_sequence_identity
 USING (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id())
 WITH CHECK (organisation_id=pharmacart_current_organisation_id() AND branch_id=pharmacart_current_branch_id());
-- Deliberately no UPDATE and no DELETE. The record of what a second already
-- holds is the evidence a conflicting second export is refused against; letting
-- the runtime rewrite it would let the conflicting export erase the conflict.
GRANT SELECT,INSERT ON feed_sequence_identity TO pharmacart_runtime;
COMMENT ON TABLE feed_sequence_identity IS
 'What each installation already accepted at a given whole-second export sequence. A feed presenting the same batch key, partition key and content digest is a replay and proceeds so the inventory reducer can recognise the duplicate; anything else at that sequence is refused as changed_content_same_sequence rather than collapsed into the existing snapshot. Append-only to pharmacart_runtime.';
COMMENT ON COLUMN feed_sequence_identity.content_digest IS
 'Digest of the canonical adapted rows, as produced by deriveSnapshotEnvelope. It is taken after adaptation and sorting, so line endings, a byte order mark or a different row order do not make one export look like two.';
COMMENT ON COLUMN feed_sequence_identity.sequence IS
 'Whole seconds of the export instant the operator declared in the feed manifest. It is never the file modified time: a copied file has a new modified time and would mint a second snapshot for the same stock.';
