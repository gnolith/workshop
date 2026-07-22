ALTER TABLE workshop_tasks ADD COLUMN title TEXT;
ALTER TABLE workshop_tasks ADD COLUMN objective TEXT;
ALTER TABLE workshop_tasks ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(constraints_json) AND json_type(constraints_json) = 'array');
ALTER TABLE workshop_tasks ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json) = 'array');
ALTER TABLE workshop_tasks ADD COLUMN relationships_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(relationships_json) AND json_type(relationships_json) = 'array');
ALTER TABLE workshop_tasks ADD COLUMN assigned_principal_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN outcome_kind TEXT
  CHECK (outcome_kind IS NULL OR outcome_kind IN ('success', 'negative', 'inconclusive'));
ALTER TABLE workshop_tasks ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE workshop_tasks ADD COLUMN attribution_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(attribution_json) AND json_type(attribution_json) = 'object');
ALTER TABLE workshop_tasks ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1
  CHECK (policy_revision >= 1);
ALTER TABLE workshop_tasks ADD COLUMN search_event_id TEXT;
ALTER TABLE workshop_tasks ADD COLUMN search_event_sequence INTEGER
  CHECK (search_event_sequence IS NULL OR search_event_sequence >= 1);

UPDATE workshop_tasks SET title = description WHERE title IS NULL;

ALTER TABLE workshop_memories ADD COLUMN title TEXT;
ALTER TABLE workshop_memories ADD COLUMN applicability_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(applicability_json) AND json_type(applicability_json) = 'object');
ALTER TABLE workshop_memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object');
ALTER TABLE workshop_memories ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE workshop_memories ADD COLUMN attribution_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(attribution_json) AND json_type(attribution_json) = 'object');
ALTER TABLE workshop_memories ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1
  CHECK (policy_revision >= 1);
ALTER TABLE workshop_memories ADD COLUMN deleted_at TEXT;
ALTER TABLE workshop_memories ADD COLUMN search_event_id TEXT;
ALTER TABLE workshop_memories ADD COLUMN search_event_sequence INTEGER
  CHECK (search_event_sequence IS NULL OR search_event_sequence >= 1);

UPDATE workshop_memories SET title = description WHERE title IS NULL;

CREATE TABLE workshop_task_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  actor_principal_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);

CREATE TABLE workshop_memory_revisions (
  installation_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  actor_principal_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, memory_id, revision)
);

CREATE TABLE workshop_prompts (
  installation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  scope TEXT,
  role TEXT,
  variables_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(variables_json) AND json_type(variables_json) = 'object'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000000 AND 1000000),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -1000000 AND 1000000),
  language TEXT NOT NULL DEFAULT 'en',
  attribution_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(attribution_json) AND json_type(attribution_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision >= 1),
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  visibility_scope TEXT NOT NULL
    CHECK (json_valid(visibility_scope) AND json_type(visibility_scope) = 'object'),
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deactivated_at TEXT,
  deleted_at TEXT,
  search_event_id TEXT,
  search_event_sequence INTEGER
    CHECK (search_event_sequence IS NULL OR search_event_sequence >= 1),
  PRIMARY KEY (installation_id, id),
  UNIQUE (installation_id, workspace_id, name)
);

CREATE TABLE workshop_prompt_revisions (
  installation_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  actor_principal_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, prompt_id, revision)
);

CREATE INDEX workshop_task_revisions_history_idx
  ON workshop_task_revisions (task_id, revision DESC);
CREATE INDEX workshop_memory_revisions_history_idx
  ON workshop_memory_revisions (installation_id, memory_id, revision DESC);
CREATE INDEX workshop_prompts_list_idx
  ON workshop_prompts (installation_id, workspace_id, deleted_at, active, priority DESC, sort_order, updated_at DESC, id);
CREATE INDEX workshop_prompts_authorization_idx
  ON workshop_prompts (installation_id, workspace_id, authorization_revision, updated_at DESC, id);
CREATE INDEX workshop_prompt_revisions_history_idx
  ON workshop_prompt_revisions (installation_id, prompt_id, revision DESC);

INSERT INTO workshop_task_revisions
  (task_id, revision, snapshot_json, actor_principal_id, event_id, created_at)
SELECT id, revision,
       json_object('legacyAdopted', 1, 'id', id, 'revision', revision),
       owner_principal_id, 'legacy-task:' || id || ':' || revision, updated_at
FROM workshop_tasks
WHERE installation_id IS NOT NULL AND owner_principal_id IS NOT NULL;

INSERT INTO workshop_memory_revisions
  (installation_id, memory_id, revision, snapshot_json, actor_principal_id, event_id, created_at)
SELECT installation_id, slug, revision,
       json_object('legacyAdopted', 1, 'id', slug, 'revision', revision),
       owner_principal_id, 'legacy-memory:' || installation_id || ':' || slug || ':' || revision,
       updated_at
FROM workshop_memories
WHERE installation_id IS NOT NULL AND owner_principal_id IS NOT NULL;

DROP TABLE workshop_cursor_entries;
DROP TABLE workshop_cursor_snapshots;

CREATE TABLE workshop_cursor_snapshots (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  search_generation INTEGER NOT NULL CHECK (search_generation >= 0),
  domain TEXT NOT NULL CHECK (domain IN ('task', 'memory', 'prompt')),
  operation TEXT NOT NULL,
  query_digest TEXT NOT NULL,
  filters_digest TEXT NOT NULL,
  page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 200),
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND 5000),
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
SET version = 6,
    package_version = '0.4.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
