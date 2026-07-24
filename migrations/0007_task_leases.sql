ALTER TABLE workshop_tasks ADD COLUMN lease_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN lease_token_digest TEXT;
ALTER TABLE workshop_tasks ADD COLUMN lease_owner_principal_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN lease_expires_at TEXT;

CREATE TABLE workshop_task_lease_receipts (
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('release', 'complete')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, principal_id, idempotency_key)
);

CREATE TABLE workshop_task_lease_events (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('claimed', 'reclaimed_expired', 'released', 'completed')
  ),
  task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX workshop_tasks_lease_expiry_idx
  ON workshop_tasks (installation_id, lease_expires_at, id);
CREATE INDEX workshop_task_lease_events_task_idx
  ON workshop_task_lease_events (installation_id, task_id, created_at);

UPDATE workshop_schema
SET version = 7,
    package_version = '0.5.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
