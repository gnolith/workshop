ALTER TABLE workshop_tasks
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

ALTER TABLE workshop_memories
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

UPDATE workshop_schema
SET version = 2,
    package_version = '0.2.0',
    updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
