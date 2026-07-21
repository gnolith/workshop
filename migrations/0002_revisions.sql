ALTER TABLE workshop_tasks
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

ALTER TABLE workshop_memories
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

-- Version-one rows used SQLite's CURRENT_TIMESTAMP representation while the
-- public API returns ISO timestamps.  Persist the public representation before
-- timestamp-based compare-and-swap is used against an adopted row.
UPDATE workshop_tasks
SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);

UPDATE workshop_memories
SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);

UPDATE workshop_schema
SET version = 2,
    package_version = '0.2.1',
    updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
