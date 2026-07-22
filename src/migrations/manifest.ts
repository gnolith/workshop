export interface WorkshopMigration {
  id: string;
  checksum: string;
  sql: string;
}

export const WORKSHOP_SCHEMA_VERSION = 5;

export const workshopMigrations: readonly WorkshopMigration[] = [
  {
    id: '0001_workshop',
    checksum:
      'sha256:aa9530e119ef575a4c772aefd267330493fb61286952b3d7cc2399cfd5255cd5',
    sql: `CREATE TABLE workshop_tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  description TEXT NOT NULL,
  role TEXT,
  prompt TEXT NOT NULL,
  context_queries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context_queries)),
  memory_slugs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(memory_slugs)),
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1)),
  claimed_at TEXT,
  completed_at TEXT,
  archived_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (claimed = 0 AND claimed_at IS NULL)
    OR (claimed = 1 AND claimed_at IS NOT NULL AND completed_at IS NULL AND archived_at IS NULL)
  )
);

CREATE TABLE workshop_memories (
  slug TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workshop_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL,
  package_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO workshop_schema (singleton, version, package_version)
VALUES (1, 1, '0.1.0');

CREATE INDEX workshop_tasks_state_idx
  ON workshop_tasks (archived_at, completed_at, claimed, updated_at DESC, id);
CREATE INDEX workshop_tasks_role_idx
  ON workshop_tasks (role, updated_at DESC, id);
CREATE INDEX workshop_tasks_updated_idx
  ON workshop_tasks (updated_at DESC, id);
CREATE INDEX workshop_memories_updated_idx
  ON workshop_memories (updated_at DESC, slug);`,
  },
  {
    id: '0002_revisions',
    checksum:
      'sha256:7c93d96a8a347c4cffa638ece281e852c53e19b18306038d4713d5354eaf57a1',
    sql: `ALTER TABLE workshop_tasks
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
WHERE singleton = 1;`,
  },
  {
    id: '0003_resumable_onboarding',
    checksum:
      'sha256:cff4481636be20da891ce527f6061e668b86e34bf3616f6b95a6439468762531',
    sql: `CREATE TABLE workshop_onboarding_runs (
  key TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'running', 'retryable', 'operator_action_required', 'completed')
  ),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state != 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE workshop_onboarding_steps (
  run_key TEXT NOT NULL REFERENCES workshop_onboarding_runs(key) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('entity', 'memory', 'task')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'applying', 'completed', 'retryable', 'operator_action_required')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_key, ordinal),
  UNIQUE (run_key, step_key)
);

CREATE INDEX workshop_onboarding_runs_state_idx
  ON workshop_onboarding_runs (state, lease_expires_at, updated_at);
CREATE INDEX workshop_onboarding_steps_state_idx
  ON workshop_onboarding_steps (run_key, state, ordinal);

UPDATE workshop_schema
SET version = 3,
    package_version = '0.2.2',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;`,
  },
  {
    id: '0004_authorization',
    checksum:
      'sha256:4959f42d9bf12698aa75427fce891e9e40d8b5d496b39a5078e0edd67204b6d6',
    sql: `ALTER TABLE workshop_tasks ADD COLUMN installation_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN owner_principal_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN workspace_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN visibility_scope TEXT
  CHECK (visibility_scope IS NULL OR (json_valid(visibility_scope) AND json_type(visibility_scope) = 'object'));
ALTER TABLE workshop_tasks ADD COLUMN authorization_revision INTEGER
  CHECK (authorization_revision IS NULL OR authorization_revision >= 0);

CREATE TABLE workshop_memories_v4 (
  slug TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  idempotency_key TEXT,
  installation_id TEXT,
  owner_principal_id TEXT,
  workspace_id TEXT,
  visibility_scope TEXT CHECK (
    visibility_scope IS NULL OR (json_valid(visibility_scope) AND json_type(visibility_scope) = 'object')
  ),
  authorization_revision INTEGER CHECK (
    authorization_revision IS NULL OR authorization_revision >= 0
  ),
  PRIMARY KEY (installation_id, slug),
  CHECK (
    (installation_id IS NULL AND owner_principal_id IS NULL AND workspace_id IS NULL
      AND visibility_scope IS NULL AND authorization_revision IS NULL)
    OR
    (installation_id IS NOT NULL AND owner_principal_id IS NOT NULL AND workspace_id IS NOT NULL
      AND visibility_scope IS NOT NULL AND authorization_revision IS NOT NULL)
  )
);

INSERT INTO workshop_memories_v4
  (slug, description, content, created_at, updated_at, revision)
SELECT slug, description, content, created_at, updated_at, revision
FROM workshop_memories;

DROP TABLE workshop_memories;
ALTER TABLE workshop_memories_v4 RENAME TO workshop_memories;
CREATE INDEX workshop_memories_updated_idx
  ON workshop_memories (updated_at DESC, slug);

CREATE INDEX workshop_tasks_authorization_idx
  ON workshop_tasks (installation_id, workspace_id, authorization_revision, updated_at DESC, id);
CREATE INDEX workshop_memories_authorization_idx
  ON workshop_memories (installation_id, workspace_id, authorization_revision, updated_at DESC, slug);
CREATE UNIQUE INDEX workshop_memories_idempotency_idx
  ON workshop_memories (installation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE workshop_schema
SET version = 4,
    package_version = '0.3.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;`,
  },
  {
    id: '0005_cursor_snapshots',
    checksum:
      'sha256:72b91be58d9f56d81c7cb237ca67370ba0766a5b96920848503bd69f07cde091',
    sql: `CREATE TABLE workshop_cursor_snapshots (
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
WHERE singleton = 1;`,
  },
] as const;

export const expectedWorkshopTables = [
  'workshop_cursor_entries',
  'workshop_cursor_snapshots',
  'workshop_memories',
  'workshop_onboarding_runs',
  'workshop_onboarding_steps',
  'workshop_schema',
  'workshop_tasks',
] as const;

export const expectedWorkshopIndexes = [
  'workshop_cursor_snapshots_expiry_idx',
  'workshop_memories_authorization_idx',
  'workshop_memories_idempotency_idx',
  'workshop_memories_updated_idx',
  'workshop_onboarding_runs_state_idx',
  'workshop_onboarding_steps_state_idx',
  'workshop_tasks_role_idx',
  'workshop_tasks_authorization_idx',
  'workshop_tasks_state_idx',
  'workshop_tasks_updated_idx',
] as const;
