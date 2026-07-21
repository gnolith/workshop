ALTER TABLE workshop_tasks
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

ALTER TABLE workshop_memories
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

-- Version-one rows used SQLite's CURRENT_TIMESTAMP representation while the
-- public API and chronological predicates use canonical ISO timestamps.
-- Normalize every persisted legacy timestamp before either compare-and-swap or
-- claim-cutoff comparisons are used against an adopted row.
UPDATE workshop_tasks
SET claimed_at = CASE
      WHEN claimed_at IS NULL THEN NULL
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at)
    END,
    completed_at = CASE
      WHEN completed_at IS NULL THEN NULL
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
    END,
    archived_at = CASE
      WHEN archived_at IS NULL THEN NULL
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', archived_at)
    END,
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);

UPDATE workshop_memories
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);

UPDATE workshop_schema
SET version = 2,
    package_version = '0.2.2',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
