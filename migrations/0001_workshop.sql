CREATE TABLE workshop_tasks (
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
  ON workshop_memories (updated_at DESC, slug);

