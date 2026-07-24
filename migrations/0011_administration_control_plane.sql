CREATE TABLE workshop_authorization_principals (
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('active', 'disabled', 'revoked')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, principal_id)
);

CREATE TABLE workshop_workspace_memberships (
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, principal_id, workspace_id)
);

CREATE TABLE workshop_oauth_bindings (
  installation_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, issuer, subject)
);

CREATE INDEX workshop_oauth_bindings_principal_idx
  ON workshop_oauth_bindings (
    installation_id,
    principal_id,
    workspace_id,
    active
  );

CREATE TABLE workshop_authorization_admin_receipts (
  installation_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, actor_principal_id, idempotency_key)
);

CREATE TABLE workshop_authorization_audit (
  audit_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (
    authorization_revision >= 1
  ),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX workshop_authorization_audit_installation_idx
  ON workshop_authorization_audit (
    installation_id,
    created_at DESC,
    audit_id
  );

CREATE TABLE workshop_semantic_configuration_state (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE workshop_semantic_configuration_receipts (
  installation_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, actor_principal_id, idempotency_key)
);

UPDATE workshop_schema
SET version = 11,
    package_version = '0.5.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
