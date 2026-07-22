ALTER TABLE workshop_tasks ADD COLUMN installation_id TEXT;
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
WHERE singleton = 1;
