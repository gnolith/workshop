CREATE TABLE workshop_cursor_snapshots (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  search_generation INTEGER NOT NULL CHECK (search_generation >= 0),
  domain TEXT NOT NULL CHECK (domain IN ('task', 'memory')),
  operation TEXT NOT NULL,
  query_digest TEXT NOT NULL,
  filters_digest TEXT NOT NULL,
  page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 200),
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND 1000),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE workshop_cursor_entries (
  snapshot_id TEXT NOT NULL REFERENCES workshop_cursor_snapshots(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  record_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, record_id)
);

CREATE INDEX workshop_cursor_snapshots_expiry_idx
  ON workshop_cursor_snapshots (expires_at, id);

UPDATE workshop_schema
SET version = 5,
    package_version = '0.3.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
