CREATE TABLE workshop_onboarding_runs (
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
WHERE singleton = 1;
