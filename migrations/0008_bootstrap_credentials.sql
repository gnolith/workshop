CREATE TABLE workshop_credentials (
  installation_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile = 'local-bearer-v1'),
  token_digest TEXT NOT NULL CHECK (
    length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'
  ),
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, credential_id),
  UNIQUE (installation_id, token_digest)
);

CREATE INDEX workshop_credentials_principal_idx
  ON workshop_credentials (installation_id, principal_id, workspace_id);

CREATE TABLE workshop_bootstrap_receipts (
  installation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  grant_manifest_digest TEXT NOT NULL CHECK (
    length(grant_manifest_digest) = 64
    AND grant_manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  owner_receipt_json TEXT NOT NULL CHECK (json_valid(owner_receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, idempotency_key),
  FOREIGN KEY (installation_id, credential_id)
    REFERENCES workshop_credentials(installation_id, credential_id)
);

UPDATE workshop_schema
SET version = 8,
    package_version = '0.5.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
