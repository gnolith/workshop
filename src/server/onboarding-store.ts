import type {
  OnboardingFailure,
  OnboardingRunState,
  OnboardingStepKind,
  OnboardingStepState,
} from '../protocol/onboarding.js';
import type { D1DatabaseLike } from './database.js';

export interface StoredOnboardingStep {
  key: string;
  ordinal: number;
  kind: OnboardingStepKind;
  input: unknown;
  state: OnboardingStepState;
  attempts: number;
  receipt?: unknown;
  failure?: OnboardingFailure;
}

export interface StoredOnboardingRun {
  key: string;
  planJson: string;
  principalId: string;
  state: OnboardingRunState;
  leaseToken?: string;
  leaseExpiresAt?: string;
  failure?: OnboardingFailure;
  steps: StoredOnboardingStep[];
}

export interface NewOnboardingStep {
  key: string;
  ordinal: number;
  kind: OnboardingStepKind;
  input: unknown;
}

/**
 * Durable workflow journal. Every mutating method must be atomic. Implementations
 * may use a stronger local transaction, but must never imply that an external
 * knowledge write participates in that transaction.
 */
export interface OnboardingCheckpointStore {
  get(key: string): Promise<StoredOnboardingRun | null>;
  create(
    key: string,
    planJson: string,
    principalId: string,
    steps: readonly NewOnboardingStep[],
    now: string,
  ): Promise<StoredOnboardingRun>;
  claim(
    key: string,
    leaseToken: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  markApplying(
    key: string,
    stepKey: string,
    leaseToken: string,
    now: string,
  ): Promise<boolean>;
  completeStep(
    key: string,
    stepKey: string,
    leaseToken: string,
    receipt: unknown,
    now: string,
  ): Promise<boolean>;
  failStep(
    key: string,
    stepKey: string,
    leaseToken: string,
    state: 'retryable' | 'operator_action_required',
    failure: OnboardingFailure,
    now: string,
  ): Promise<boolean>;
  completeRun(key: string, leaseToken: string, now: string): Promise<boolean>;
}

interface RunRow {
  key: string;
  plan_json: string;
  principal_id: string;
  state: OnboardingRunState;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error_json: string | null;
}

interface StepRow {
  step_key: string;
  ordinal: number;
  kind: OnboardingStepKind;
  input_json: string;
  state: OnboardingStepState;
  attempts: number;
  receipt_json: string | null;
  error_json: string | null;
}

export class SqlOnboardingCheckpointStore implements OnboardingCheckpointStore {
  constructor(readonly db: D1DatabaseLike) {}

  async get(key: string): Promise<StoredOnboardingRun | null> {
    const row = await this.db
      .prepare('SELECT * FROM workshop_onboarding_runs WHERE key = ?')
      .bind(key)
      .first<RunRow>();
    if (!row) return null;
    const result = await this.db
      .prepare(
        'SELECT * FROM workshop_onboarding_steps WHERE run_key = ? ORDER BY ordinal ASC',
      )
      .bind(key)
      .all<StepRow>();
    return {
      key: row.key,
      planJson: row.plan_json,
      principalId: row.principal_id,
      state: row.state,
      ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.last_error_json
        ? { failure: JSON.parse(row.last_error_json) as OnboardingFailure }
        : {}),
      steps: (result.results ?? []).map((step) => ({
        key: step.step_key,
        ordinal: step.ordinal,
        kind: step.kind,
        input: JSON.parse(step.input_json) as unknown,
        state: step.state,
        attempts: step.attempts,
        ...(step.receipt_json
          ? { receipt: JSON.parse(step.receipt_json) as unknown }
          : {}),
        ...(step.error_json
          ? { failure: JSON.parse(step.error_json) as OnboardingFailure }
          : {}),
      })),
    };
  }

  async create(
    key: string,
    planJson: string,
    principalId: string,
    steps: readonly NewOnboardingStep[],
    now: string,
  ): Promise<StoredOnboardingRun> {
    const statements = [
      this.db
        .prepare(
          `INSERT INTO workshop_onboarding_runs
           (key, plan_json, principal_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(key) DO NOTHING`,
        )
        .bind(key, planJson, principalId, now, now),
      ...steps.map((step) =>
        this.db
          .prepare(
            `INSERT INTO workshop_onboarding_steps
             (run_key, step_key, ordinal, kind, input_json, state, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, 'pending', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM workshop_onboarding_runs
               WHERE key = ? AND plan_json = ?
             )
             ON CONFLICT(run_key, step_key) DO NOTHING`,
          )
          .bind(
            key,
            step.key,
            step.ordinal,
            step.kind,
            JSON.stringify(step.input),
            now,
            now,
            key,
            planJson,
          ),
      ),
    ];
    await this.db.batch(statements);
    const run = await this.get(key);
    if (!run) throw new Error(`Failed to create onboarding run ${key}`);
    return run;
  }

  async claim(
    key: string,
    leaseToken: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE workshop_onboarding_runs
         SET state = 'running', lease_token = ?, lease_expires_at = ?,
             last_error_json = NULL, updated_at = ?
         WHERE key = ? AND (
           state IN ('pending', 'retryable')
           OR (state = 'running' AND lease_expires_at <= ?)
         ) RETURNING key`,
      )
      .bind(leaseToken, leaseExpiresAt, now, key, now)
      .first<{ key: string }>();
    return Boolean(row);
  }

  async markApplying(
    key: string,
    stepKey: string,
    leaseToken: string,
    now: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE workshop_onboarding_steps
         SET state = 'applying', attempts = attempts + 1,
             error_json = NULL, updated_at = ?
         WHERE run_key = ? AND step_key = ?
           AND state != 'completed'
           AND EXISTS (
             SELECT 1 FROM workshop_onboarding_runs
             WHERE key = ? AND state = 'running' AND lease_token = ?
           ) RETURNING step_key`,
      )
      .bind(now, key, stepKey, key, leaseToken)
      .first<{ step_key: string }>();
    return Boolean(row);
  }

  async completeStep(
    key: string,
    stepKey: string,
    leaseToken: string,
    receipt: unknown,
    now: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE workshop_onboarding_steps
         SET state = 'completed', receipt_json = ?, error_json = NULL,
             updated_at = ?
         WHERE run_key = ? AND step_key = ? AND state = 'applying'
           AND EXISTS (
             SELECT 1 FROM workshop_onboarding_runs
             WHERE key = ? AND state = 'running' AND lease_token = ?
           ) RETURNING step_key`,
      )
      .bind(JSON.stringify(receipt), now, key, stepKey, key, leaseToken)
      .first<{ step_key: string }>();
    return Boolean(row);
  }

  async failStep(
    key: string,
    stepKey: string,
    leaseToken: string,
    state: 'retryable' | 'operator_action_required',
    failure: OnboardingFailure,
    now: string,
  ): Promise<boolean> {
    const failureJson = JSON.stringify(failure);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE workshop_onboarding_steps
           SET state = ?, error_json = ?, updated_at = ?
           WHERE run_key = ? AND step_key = ? AND state = 'applying'
             AND EXISTS (
               SELECT 1 FROM workshop_onboarding_runs
               WHERE key = ? AND state = 'running' AND lease_token = ?
             )`,
        )
        .bind(state, failureJson, now, key, stepKey, key, leaseToken),
      this.db
        .prepare(
          `UPDATE workshop_onboarding_runs
           SET state = ?, lease_token = NULL, lease_expires_at = NULL,
               last_error_json = ?, updated_at = ?
           WHERE key = ? AND state = 'running' AND lease_token = ?`,
        )
        .bind(state, failureJson, now, key, leaseToken),
    ]);
    return results.every((result) => result.success);
  }

  async completeRun(
    key: string,
    leaseToken: string,
    now: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE workshop_onboarding_runs
         SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
             last_error_json = NULL, completed_at = ?, updated_at = ?
         WHERE key = ? AND state = 'running' AND lease_token = ?
           AND NOT EXISTS (
             SELECT 1 FROM workshop_onboarding_steps
             WHERE run_key = ? AND state != 'completed'
           ) RETURNING key`,
      )
      .bind(now, now, key, leaseToken, key)
      .first<{ key: string }>();
    return Boolean(row);
  }
}
