CREATE TABLE workshop_operation_receipts (
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'memory.delete',
      'prompt.create',
      'prompt.update',
      'prompt.delete'
    )
  ),
  idempotency_key TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    installation_id,
    principal_id,
    operation,
    idempotency_key
  )
);

CREATE INDEX workshop_operation_receipts_subject_idx
  ON workshop_operation_receipts (
    installation_id,
    operation,
    subject_id,
    created_at
  );

UPDATE workshop_schema
SET version = 9,
    package_version = '0.5.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
