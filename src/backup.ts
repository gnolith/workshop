import { WorkshopError } from './protocol/errors.js';
import type { D1DatabaseLike } from './server/database.js';
import type {
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
} from '@gnolith/diamond';

export * from './legacy-owner.js';

export interface WorkshopBackupDocumentV1 {
  format: 'gnolith-workshop-backup-v1';
  version: 1;
  createdAt: string;
  installationId: string;
  schemaVersion: number;
  sections: {
    workshop: unknown;
    migrationLedgerSlice: unknown;
  };
}

export interface WorkshopBackupInspection {
  valid: boolean;
  format: 'gnolith-workshop-backup-v1';
  version: 1;
  installationId: string;
  schemaVersion: number;
  legacy: {
    taskCount: number;
    memoryCount: number;
    promptCount: number;
    onboarding: {
      retained: number;
      migrated: number;
      deferred: number;
    };
  };
}

export interface WorkshopBackupOwnerHandle {
  readonly owner: '@gnolith/workshop';
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  exportOwnedState(input: {
    installationId: string;
    signal: AbortSignal;
  }): Promise<unknown>;
  inspectOwnedState(input: { state: unknown; signal: AbortSignal }): Promise<{
    taskCount: number;
    memoryCount: number;
    promptCount: number;
    onboarding: {
      retained: number;
      migrated: number;
      deferred: number;
    };
  }>;
  importOwnedState(input: {
    installationId: string;
    state: unknown;
    expireTaskLeasesAt: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkshopMigrationLedgerBackupHandle {
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  exportOwnedSlice(input: { signal: AbortSignal }): Promise<unknown>;
  inspectOwnedSlice(input: {
    state: unknown;
    signal: AbortSignal;
  }): Promise<void>;
  importOwnedSlice(input: {
    state: unknown;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkshopBackupDependencies {
  owner: WorkshopBackupOwnerHandle;
  ledger: WorkshopMigrationLedgerBackupHandle;
  schemaVersion: number;
  clock?: () => Date;
}

export interface CreateWorkshopOwnerHandlesOptionsV1 {
  db: D1DatabaseLike;
  installationId: string;
  connectionId: string;
  registrationFingerprint: string;
  ledgerBackup: MigrationLedgerBackup;
  ledgerOwner: MigrationLedgerOwnerHandle;
}

export interface WorkshopOwnerHandlesV1 {
  owner: WorkshopBackupOwnerHandle;
  ledger: WorkshopMigrationLedgerBackupHandle;
}

interface WorkshopOwnedStateV1 {
  format: 'gnolith-workshop-owned-state-v1';
  installationId: string;
  tables: Record<string, readonly Record<string, unknown>[]>;
}

const WORKSHOP_BACKUP_QUERIES = [
  ['workshop_onboarding_runs', 'SELECT * FROM workshop_onboarding_runs'],
  ['workshop_onboarding_steps', 'SELECT * FROM workshop_onboarding_steps'],
  ['workshop_tasks', 'SELECT * FROM workshop_tasks WHERE installation_id = ?'],
  [
    'workshop_task_revisions',
    `SELECT revisions.* FROM workshop_task_revisions revisions
     JOIN workshop_tasks tasks ON tasks.id = revisions.task_id
     WHERE tasks.installation_id = ?`,
  ],
  [
    'workshop_memories',
    'SELECT * FROM workshop_memories WHERE installation_id = ?',
  ],
  [
    'workshop_memory_revisions',
    'SELECT * FROM workshop_memory_revisions WHERE installation_id = ?',
  ],
  [
    'workshop_prompts',
    'SELECT * FROM workshop_prompts WHERE installation_id = ?',
  ],
  [
    'workshop_prompt_revisions',
    'SELECT * FROM workshop_prompt_revisions WHERE installation_id = ?',
  ],
  [
    'workshop_cursor_snapshots',
    'SELECT * FROM workshop_cursor_snapshots WHERE installation_id = ?',
  ],
  [
    'workshop_cursor_entries',
    `SELECT entries.* FROM workshop_cursor_entries entries
     JOIN workshop_cursor_snapshots snapshots ON snapshots.id = entries.snapshot_id
     WHERE snapshots.installation_id = ?`,
  ],
  [
    'workshop_task_lease_receipts',
    'SELECT * FROM workshop_task_lease_receipts WHERE installation_id = ?',
  ],
  [
    'workshop_task_lease_events',
    'SELECT * FROM workshop_task_lease_events WHERE installation_id = ?',
  ],
  [
    'workshop_credentials',
    'SELECT * FROM workshop_credentials WHERE installation_id = ?',
  ],
  [
    'workshop_bootstrap_receipts',
    'SELECT * FROM workshop_bootstrap_receipts WHERE installation_id = ?',
  ],
  [
    'workshop_operation_receipts',
    'SELECT * FROM workshop_operation_receipts WHERE installation_id = ?',
  ],
  [
    'workshop_authorization_principals',
    'SELECT * FROM workshop_authorization_principals WHERE installation_id = ?',
  ],
  [
    'workshop_workspace_memberships',
    'SELECT * FROM workshop_workspace_memberships WHERE installation_id = ?',
  ],
  [
    'workshop_oauth_bindings',
    'SELECT * FROM workshop_oauth_bindings WHERE installation_id = ?',
  ],
  [
    'workshop_authorization_admin_receipts',
    'SELECT * FROM workshop_authorization_admin_receipts WHERE installation_id = ?',
  ],
  [
    'workshop_authorization_audit',
    'SELECT * FROM workshop_authorization_audit WHERE installation_id = ?',
  ],
  [
    'workshop_semantic_configuration_state',
    'SELECT * FROM workshop_semantic_configuration_state WHERE installation_id = ?',
  ],
  [
    'workshop_semantic_configuration_receipts',
    'SELECT * FROM workshop_semantic_configuration_receipts WHERE installation_id = ?',
  ],
] as const;

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

const RESTORE_DELETE_QUERIES = [
  `DELETE FROM workshop_onboarding_steps`,
  `DELETE FROM workshop_onboarding_runs`,
  `DELETE FROM workshop_cursor_entries
   WHERE snapshot_id IN (
     SELECT id FROM workshop_cursor_snapshots WHERE installation_id = ?
   )`,
  `DELETE FROM workshop_cursor_snapshots WHERE installation_id = ?`,
  `DELETE FROM workshop_task_lease_receipts WHERE installation_id = ?`,
  `DELETE FROM workshop_task_lease_events WHERE installation_id = ?`,
  `DELETE FROM workshop_task_revisions
   WHERE task_id IN (
     SELECT id FROM workshop_tasks WHERE installation_id = ?
   )`,
  `DELETE FROM workshop_memory_revisions WHERE installation_id = ?`,
  `DELETE FROM workshop_prompt_revisions WHERE installation_id = ?`,
  `DELETE FROM workshop_operation_receipts WHERE installation_id = ?`,
  `DELETE FROM workshop_bootstrap_receipts WHERE installation_id = ?`,
  `DELETE FROM workshop_credentials WHERE installation_id = ?`,
  `DELETE FROM workshop_authorization_admin_receipts WHERE installation_id = ?`,
  `DELETE FROM workshop_authorization_audit WHERE installation_id = ?`,
  `DELETE FROM workshop_oauth_bindings WHERE installation_id = ?`,
  `DELETE FROM workshop_workspace_memberships WHERE installation_id = ?`,
  `DELETE FROM workshop_authorization_principals WHERE installation_id = ?`,
  `DELETE FROM workshop_semantic_configuration_receipts WHERE installation_id = ?`,
  `DELETE FROM workshop_semantic_configuration_state WHERE installation_id = ?`,
  `DELETE FROM workshop_prompts WHERE installation_id = ?`,
  `DELETE FROM workshop_memories WHERE installation_id = ?`,
  `DELETE FROM workshop_tasks WHERE installation_id = ?`,
] as const;

const BACKUP_UNIQUE_KEYS: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  workshop_onboarding_runs: [['key']],
  workshop_onboarding_steps: [
    ['run_key', 'ordinal'],
    ['run_key', 'step_key'],
  ],
  workshop_tasks: [['id'], ['idempotency_key']],
  workshop_task_revisions: [['task_id', 'revision'], ['event_id']],
  workshop_memories: [
    ['installation_id', 'slug'],
    ['installation_id', 'idempotency_key'],
  ],
  workshop_memory_revisions: [
    ['installation_id', 'memory_id', 'revision'],
    ['event_id'],
  ],
  workshop_prompts: [
    ['installation_id', 'id'],
    ['installation_id', 'workspace_id', 'name'],
  ],
  workshop_prompt_revisions: [
    ['installation_id', 'prompt_id', 'revision'],
    ['event_id'],
  ],
  workshop_cursor_snapshots: [['id']],
  workshop_cursor_entries: [
    ['snapshot_id', 'ordinal'],
    ['snapshot_id', 'record_id'],
  ],
  workshop_task_lease_receipts: [
    ['installation_id', 'principal_id', 'idempotency_key'],
  ],
  workshop_task_lease_events: [['event_id']],
  workshop_credentials: [
    ['installation_id', 'credential_id'],
    ['installation_id', 'token_digest'],
  ],
  workshop_bootstrap_receipts: [['installation_id', 'idempotency_key']],
  workshop_operation_receipts: [
    ['installation_id', 'principal_id', 'operation', 'idempotency_key'],
  ],
  workshop_authorization_principals: [['installation_id', 'principal_id']],
  workshop_workspace_memberships: [
    ['installation_id', 'principal_id', 'workspace_id'],
  ],
  workshop_oauth_bindings: [['installation_id', 'issuer', 'subject']],
  workshop_authorization_admin_receipts: [
    ['installation_id', 'actor_principal_id', 'idempotency_key'],
  ],
  workshop_authorization_audit: [['audit_id']],
  workshop_semantic_configuration_state: [['installation_id']],
  workshop_semantic_configuration_receipts: [
    ['installation_id', 'actor_principal_id', 'idempotency_key'],
  ],
};

/**
 * Creates sealed Workshop-owned backup handles around one qualified database
 * binding and Diamond's public namespaced-ledger capability.
 */
export function createWorkshopOwnerHandlesV1(
  options: CreateWorkshopOwnerHandlesOptionsV1,
): WorkshopOwnerHandlesV1 {
  validateIdentifier(options.installationId);
  if (
    !validBinding(options.connectionId) ||
    !/^[a-f0-9]{64}$/u.test(options.registrationFingerprint) ||
    options.ledgerOwner.namespace !== '@gnolith/workshop' ||
    options.ledgerOwner.installationId !== options.installationId ||
    options.ledgerOwner.connectionId !== options.connectionId
  )
    throw invalid('Workshop owner handle binding is invalid');

  const owner: WorkshopBackupOwnerHandle = Object.freeze({
    owner: '@gnolith/workshop' as const,
    connectionId: options.connectionId,
    registrationFingerprint: options.registrationFingerprint,
    async exportOwnedState(
      input: Parameters<WorkshopBackupOwnerHandle['exportOwnedState']>[0],
    ) {
      const { installationId, signal } = input;
      assertInstallation(options.installationId, installationId);
      signal.throwIfAborted();
      const tables: Record<string, readonly Record<string, unknown>[]> = {};
      for (const [table, sql] of WORKSHOP_BACKUP_QUERIES) {
        signal.throwIfAborted();
        const statement = options.db.prepare(sql);
        const result = await (
          sql.includes('?') ? statement.bind(installationId) : statement
        ).all<Record<string, unknown>>();
        tables[table] = result.results.map((row) => ({ ...row }));
      }
      return {
        format: 'gnolith-workshop-owned-state-v1',
        installationId,
        tables,
      } satisfies WorkshopOwnedStateV1;
    },
    inspectOwnedState(
      input: Parameters<WorkshopBackupOwnerHandle['inspectOwnedState']>[0],
    ) {
      const { state, signal } = input;
      signal.throwIfAborted();
      const decoded = normalizeOwnedState(
        ownedState(state, options.installationId),
      );
      return Promise.resolve({
        taskCount: decoded.tables.workshop_tasks?.length ?? 0,
        memoryCount: decoded.tables.workshop_memories?.length ?? 0,
        promptCount: decoded.tables.workshop_prompts?.length ?? 0,
        onboarding: {
          retained: decoded.tables.workshop_onboarding_runs?.length ?? 0,
          migrated:
            decoded.tables.workshop_onboarding_steps?.filter(
              (row) => row.state === 'completed',
            ).length ?? 0,
          deferred:
            decoded.tables.workshop_onboarding_steps?.filter(
              (row) => row.state !== 'completed',
            ).length ?? 0,
        },
      });
    },
    async importOwnedState(
      input: Parameters<WorkshopBackupOwnerHandle['importOwnedState']>[0],
    ) {
      const { installationId, state, expireTaskLeasesAt, signal } = input;
      assertInstallation(options.installationId, installationId);
      signal.throwIfAborted();
      if (!Number.isFinite(Date.parse(expireTaskLeasesAt)))
        throw invalid('Task lease expiry is invalid');
      const decoded = normalizeOwnedState(ownedState(state, installationId));
      const statements: ReturnType<D1DatabaseLike['prepare']>[] =
        RESTORE_DELETE_QUERIES.map((sql) =>
          sql.includes('?')
            ? options.db.prepare(sql).bind(installationId)
            : options.db.prepare(sql),
        );
      for (const [table] of WORKSHOP_BACKUP_QUERIES) {
        for (const row of decoded.tables[table] ?? []) {
          signal.throwIfAborted();
          const rebound = rebindRow(row, installationId);
          const columns = Object.keys(rebound);
          statements.push(
            options.db
              .prepare(
                `INSERT INTO "${table}" (${columns
                  .map((column) => `"${column}"`)
                  .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              )
              .bind(...columns.map((column) => rebound[column])),
          );
        }
      }
      statements.push(
        options.db
          .prepare(
            `UPDATE workshop_tasks SET lease_expires_at = ?
             WHERE installation_id = ? AND lease_id IS NOT NULL`,
          )
          .bind(expireTaskLeasesAt, installationId),
      );
      await options.db.batch(statements);
    },
  });

  const ledger: WorkshopMigrationLedgerBackupHandle = Object.freeze({
    connectionId: options.connectionId,
    registrationFingerprint: options.registrationFingerprint,
    exportOwnedSlice: () =>
      options.ledgerBackup.exportNamespace(options.ledgerOwner),
    async inspectOwnedSlice(
      input: Parameters<
        WorkshopMigrationLedgerBackupHandle['inspectOwnedSlice']
      >[0],
    ) {
      const { state, signal } = input;
      signal.throwIfAborted();
      await options.ledgerBackup.validateNamespace(
        options.ledgerOwner,
        state as MigrationLedgerSlice,
      );
    },
    async importOwnedSlice(
      input: Parameters<
        WorkshopMigrationLedgerBackupHandle['importOwnedSlice']
      >[0],
    ) {
      const { state, signal } = input;
      signal.throwIfAborted();
      await options.ledgerBackup.restoreNamespace(
        options.ledgerOwner,
        state as MigrationLedgerSlice,
        { mode: 'empty' },
      );
    },
  });
  return Object.freeze({ owner, ledger });
}

export function createWorkshopBackupApi(
  dependencies: WorkshopBackupDependencies,
) {
  validateBinding(dependencies);
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async exportBackup(
      installationId: string,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupDocumentV1> {
      validateIdentifier(installationId);
      const [workshop, migrationLedgerSlice] = await Promise.all([
        dependencies.owner.exportOwnedState({ installationId, signal }),
        dependencies.ledger.exportOwnedSlice({ signal }),
      ]);
      return {
        format: 'gnolith-workshop-backup-v1',
        version: 1,
        createdAt: clock().toISOString(),
        installationId,
        schemaVersion: dependencies.schemaVersion,
        sections: { workshop, migrationLedgerSlice },
      };
    },
    async inspectBackup(
      value: unknown,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupInspection> {
      const backup = validateBackup(value, dependencies.schemaVersion);
      const legacy = await dependencies.owner.inspectOwnedState({
        state: backup.sections.workshop,
        signal,
      });
      await dependencies.ledger.inspectOwnedSlice({
        state: backup.sections.migrationLedgerSlice,
        signal,
      });
      validateCounts(legacy);
      return {
        valid: true,
        format: backup.format,
        version: backup.version,
        installationId: backup.installationId,
        schemaVersion: backup.schemaVersion,
        legacy,
      };
    },
    async importBackup(
      value: unknown,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupInspection> {
      const inspected = await this.inspectBackup(value, signal);
      const backup = value as WorkshopBackupDocumentV1;
      await dependencies.owner.importOwnedState({
        installationId: backup.installationId,
        state: backup.sections.workshop,
        expireTaskLeasesAt: clock().toISOString(),
        signal,
      });
      await dependencies.ledger.importOwnedSlice({
        state: backup.sections.migrationLedgerSlice,
        signal,
      });
      return inspected;
    },
  };
}

function validateBinding(dependencies: WorkshopBackupDependencies): void {
  if (
    dependencies.owner.owner !== '@gnolith/workshop' ||
    !dependencies.owner.connectionId ||
    dependencies.owner.connectionId !== dependencies.ledger.connectionId ||
    !dependencies.owner.registrationFingerprint ||
    dependencies.owner.registrationFingerprint !==
      dependencies.ledger.registrationFingerprint ||
    !Number.isSafeInteger(dependencies.schemaVersion) ||
    dependencies.schemaVersion < 1
  )
    throw invalid('Backup owner binding is invalid');
}

function validateBackup(
  value: unknown,
  schemaVersion: number,
): WorkshopBackupDocumentV1 {
  if (!isRecord(value)) throw invalid('Backup document must be an object');
  exactKeys(value, [
    'format',
    'version',
    'createdAt',
    'installationId',
    'schemaVersion',
    'sections',
  ]);
  if (
    value.format !== 'gnolith-workshop-backup-v1' ||
    value.version !== 1 ||
    value.schemaVersion !== schemaVersion ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.sections)
  )
    throw invalid('Backup document is incompatible');
  validateIdentifier(value.installationId);
  exactKeys(value.sections, ['workshop', 'migrationLedgerSlice']);
  return value as unknown as WorkshopBackupDocumentV1;
}

function validateCounts(value: {
  taskCount: number;
  memoryCount: number;
  promptCount: number;
  onboarding: {
    retained: number;
    migrated: number;
    deferred: number;
  };
}): void {
  for (const count of [
    value.taskCount,
    value.memoryCount,
    value.promptCount,
    value.onboarding.retained,
    value.onboarding.migrated,
    value.onboarding.deferred,
  ])
    if (!Number.isSafeInteger(count) || count < 0)
      throw invalid('Backup inspection counts are invalid');
}

function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw invalid('Backup installation identifier is invalid');
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw invalid('Backup document has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}

function validBinding(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertInstallation(expected: string, actual: string): void {
  validateIdentifier(actual);
  if (actual !== expected)
    throw invalid('Workshop owner installation binding does not match');
}

function ownedState(
  value: unknown,
  installationId: string,
): WorkshopOwnedStateV1 {
  if (
    !isRecord(value) ||
    value.format !== 'gnolith-workshop-owned-state-v1' ||
    value.installationId !== installationId ||
    !isRecord(value.tables)
  )
    throw invalid('Workshop owner state is incompatible');
  const allowed = new Set<string>(
    WORKSHOP_BACKUP_QUERIES.map(([table]) => table),
  );
  if (Object.keys(value.tables).some((table) => !allowed.has(table)))
    throw invalid('Workshop owner state contains an unknown table');
  for (const [table, rows] of Object.entries(value.tables)) {
    if (
      !allowed.has(table) ||
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !isRecord(row) ||
          Object.keys(row).length === 0 ||
          Object.keys(row).some((column) => !SQL_IDENTIFIER.test(column)),
      )
    )
      throw invalid('Workshop owner state contains invalid rows or columns');
  }
  return value as unknown as WorkshopOwnedStateV1;
}

function normalizeOwnedState(
  state: WorkshopOwnedStateV1,
): WorkshopOwnedStateV1 {
  const tables: Record<string, readonly Record<string, unknown>[]> = {};
  for (const [table] of WORKSHOP_BACKUP_QUERIES) {
    const rows = state.tables[table] ?? [];
    const uniqueKeys = BACKUP_UNIQUE_KEYS[table] ?? [];
    const seen = new Map<string, string>();
    const normalized: Record<string, unknown>[] = [];
    for (const row of rows) {
      const canonical = canonicalize(row);
      const keys = uniqueKeys
        .map((columns) => logicalKey(table, columns, row))
        .filter((key): key is string => key !== null);
      const collisions = keys
        .map((key) => seen.get(key))
        .filter((value): value is string => value !== undefined);
      if (collisions.some((value) => value !== canonical))
        throw invalid(
          `Workshop owner state contains inconsistent duplicate ${table} records`,
        );
      if (collisions.length > 0) {
        for (const key of keys) seen.set(key, canonical);
        continue;
      }
      for (const key of keys) seen.set(key, canonical);
      normalized.push({ ...row });
    }
    tables[table] = normalized;
  }
  return { ...state, tables };
}

function logicalKey(
  table: string,
  columns: readonly string[],
  row: Readonly<Record<string, unknown>>,
): string | null {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === null || value === undefined))
    return null;
  return `${table}\u0000${columns.join('\u0000')}\u0000${canonicalize(values)}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function rebindRow(
  row: Readonly<Record<string, unknown>>,
  installationId: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'installation_id' ? installationId : value,
    ]),
  );
}
export * from './resource-blobs.js';
