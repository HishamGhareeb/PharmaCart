ALTER TABLE budget ADD COLUMN spent_amount commercial_amount NOT NULL DEFAULT 0;
ALTER TABLE budget ADD CONSTRAINT budget_committed_limit CHECK(reserved_amount+spent_amount<=limit_amount);
