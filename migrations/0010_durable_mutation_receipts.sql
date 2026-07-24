ALTER TABLE workshop_task_lease_receipts
ADD COLUMN request_digest TEXT CHECK (
  request_digest IS NULL OR (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE workshop_operation_receipts
RENAME TO workshop_operation_receipts_v9;

CREATE TABLE workshop_operation_receipts (
  installation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'memory.upsert',
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

INSERT INTO workshop_operation_receipts (
  installation_id,
  principal_id,
  operation,
  idempotency_key,
  subject_id,
  request_digest,
  response_json,
  created_at
)
SELECT
  installation_id,
  principal_id,
  operation,
  idempotency_key,
  subject_id,
  request_digest,
  response_json,
  created_at
FROM workshop_operation_receipts_v9;

DROP TABLE workshop_operation_receipts_v9;

CREATE INDEX workshop_operation_receipts_subject_idx
  ON workshop_operation_receipts (
    installation_id,
    operation,
    subject_id,
    created_at
  );

UPDATE workshop_schema
SET version = 10,
    package_version = '0.5.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1;
