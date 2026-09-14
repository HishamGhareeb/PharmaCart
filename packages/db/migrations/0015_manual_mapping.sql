-- Explicit human pack mapping. Forward-only: this migration adds one append-only provenance table
-- and the least-privilege grants the mapping repository needs. No existing table, column,
-- constraint, policy or grant is dropped, relaxed or rewritten.
--
-- The shared catalogue stays immutable to the runtime role: procurement_product keeps only the
-- SELECT privilege granted by 0007, so a mapping decision can read a pack identity and never edit
-- one. Neither table below grants UPDATE or DELETE to pharmacart_runtime, so a recorded decision and
-- the mapping row it justifies are history that the request path cannot rewrite.

-- Referential integrity checks run with the privileges of the referenced table and bypass row level
-- security, so a single-column reference to need(id) or source_product_map(id) would let a runtime
-- INSERT pass the tenant_scope WITH CHECK on its own organisation and branch columns while pointing
-- at another tenant's need, or at a mapping row that carries a different product. The two additive
-- unique constraints below give the provenance table composite targets that carry that lineage into
-- the reference itself. Both are implied by the existing primary keys, so no existing row can fail
-- them and no existing constraint, policy or grant is dropped or relaxed.
ALTER TABLE need
  ADD CONSTRAINT need_organisation_branch_identity UNIQUE (organisation_id, branch_id, id);
ALTER TABLE source_product_map
  ADD CONSTRAINT source_product_map_tenant_product_identity UNIQUE (organisation_id, branch_id, id, product_id);

-- A human selection of one catalogue pack for one need, recorded next to the mapping row it created.
CREATE TABLE need_mapping_decision (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  need_id uuid NOT NULL,
  -- The need version the request declared it was acting on. Binding increments need.version, so a second
  -- decision against the same observed version is a stale or concurrent write and is refused here
  -- even if the per-need row lock were ever released early.
  need_version integer NOT NULL CHECK (need_version > 0),
  map_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES procurement_product(id),
  decided_by uuid NOT NULL,
  decision text NOT NULL CHECK (decision = 'explicit_human_selection'),
  unit_basis text NOT NULL CHECK (unit_basis IN ('authoritative_metadata', 'explicit_supplied_unit')),
  unit text NOT NULL CHECK (unit <> ''),
  -- The unit the request stated when the need carried no authoritative unit metadata. It records a
  -- claim the caller had to make explicitly, and must never be read as a unit the module verified
  -- against the need or as an automatic match.
  supplied_unit text CHECK (supplied_unit <> ''),
  authoritative_unit text CHECK (authoritative_unit <> ''),
  -- Catalogue packs that were eligible for this need when the decision was recorded, counted
  -- server-side within the API candidate bound. A count above one records that the catalogue was
  -- ambiguous at bind time. It is not evidence that any list was rendered to or read by a person.
  observed_candidate_count integer NOT NULL CHECK (observed_candidate_count >= 1),
  observed_candidates_truncated boolean NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (need_id, need_version),
  FOREIGN KEY (organisation_id, branch_id) REFERENCES branch(organisation_id, id),
  -- The need must belong to the same organisation and branch as the decision that cites it, so a
  -- provenance row can never reach across tenants even though the check itself bypasses RLS.
  FOREIGN KEY (organisation_id, branch_id, need_id) REFERENCES need(organisation_id, branch_id, id),
  -- The mapping row must belong to the same organisation and branch and must already carry exactly
  -- the product this decision claims, so provenance cannot describe a selection its mapping did not
  -- make. This subsumes a plain reference to the mapping identity, which is therefore not repeated.
  FOREIGN KEY (organisation_id, branch_id, map_id, product_id)
    REFERENCES source_product_map(organisation_id, branch_id, id, product_id),
  FOREIGN KEY (organisation_id, decided_by) REFERENCES membership(organisation_id, id),
  CONSTRAINT need_mapping_decision_supplied_basis
    CHECK (unit_basis <> 'explicit_supplied_unit' OR (supplied_unit IS NOT NULL AND authoritative_unit IS NULL)),
  CONSTRAINT need_mapping_decision_authoritative_basis
    CHECK (unit_basis <> 'authoritative_metadata' OR authoritative_unit IS NOT NULL),
  -- No pack conversion is representable: every recorded unit is the same exact string.
  CONSTRAINT need_mapping_decision_unit_consistency
    CHECK ((supplied_unit IS NULL OR supplied_unit = unit) AND (authoritative_unit IS NULL OR authoritative_unit = unit))
);

ALTER TABLE need_mapping_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE need_mapping_decision FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON need_mapping_decision
  USING (organisation_id = pharmacart_current_organisation_id() AND branch_id = pharmacart_current_branch_id())
  WITH CHECK (organisation_id = pharmacart_current_organisation_id() AND branch_id = pharmacart_current_branch_id());

REVOKE ALL ON need_mapping_decision FROM PUBLIC;
GRANT SELECT, INSERT ON need_mapping_decision TO pharmacart_runtime;

-- The mapping repository appends a new source_product_map row per explicit decision and repoints
-- need.source_map_id at it. INSERT alone is granted, so earlier mapping rows that approved quotes
-- captured stay readable and unchanged; the existing tenant_scope policy from 0007 still confines
-- every inserted row to the current organisation and branch.
GRANT INSERT ON source_product_map TO pharmacart_runtime;

COMMENT ON TABLE need_mapping_decision IS
 'Provenance for explicit human pack mapping. One row per accepted decision, keyed by the need version the request supplied as the version it was acting on. Rows are append-only to the runtime role: no UPDATE or DELETE privilege is granted, so a later mapping change adds a decision instead of rewriting one. The composite references to need and source_product_map carry organisation and branch, so a row cannot cite a need belonging to another tenant, or claim a product its mapping does not carry, even though referential checks bypass row level security.';

COMMENT ON COLUMN need_mapping_decision.observed_candidate_count IS
 'Catalogue packs eligible for this need at the moment the decision was recorded, counted server-side and bounded by the API candidate limit. A count above one means the catalogue was ambiguous and the request still named one product explicitly. It does not record what any person was shown or read: the module only proves that no selection was made automatically.';

