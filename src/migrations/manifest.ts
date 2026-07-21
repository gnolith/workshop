export interface WorkshopMigration {
  id: string;
  checksum: string;
  sql: string;
}

export const WORKSHOP_SCHEMA_VERSION = 3;

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
] as const;

export const expectedWorkshopTables = [
  'workshop_memories',
  'workshop_onboarding_runs',
  'workshop_onboarding_steps',
  'workshop_schema',
  'workshop_tasks',
] as const;

export const expectedWorkshopIndexes = [
  'workshop_memories_updated_idx',
  'workshop_onboarding_runs_state_idx',
  'workshop_onboarding_steps_state_idx',
  'workshop_tasks_role_idx',
  'workshop_tasks_state_idx',
  'workshop_tasks_updated_idx',
] as const;
