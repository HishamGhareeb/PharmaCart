-- The domain's collision-free composite keys contain escaped NUL separators.
-- PostgreSQL jsonb rejects these even though they are valid JSON strings.
-- Keep this internal restart checkpoint as JSON text; queryable projections remain normalized.
ALTER TABLE inventory_state ALTER COLUMN state TYPE text USING state::text;
