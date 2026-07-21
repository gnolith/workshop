import type { WorkshopPersistence } from './server/database.js';
import {
  WORKSHOP_SCHEMA_VERSION,
  workshopMigrations,
} from './migrations/manifest.js';

export * from './migrations/manifest.js';

export interface WorkshopMigrationResult {
  previousVersion: number;
  version: number;
  applied: string[];
}

const WORKSHOP_MIGRATION_NAMESPACE = '@gnolith/workshop';

export interface WorkshopNamespacedMigration {
  id: string;
  statements: readonly string[];
}

export interface WorkshopAppliedMigration {
  namespace: string;
  id: string;
  checksum: string;
  adopted: boolean;
  appliedAt: string;
}

/** Structural subset of Diamond's public namespaced migration API. */
export interface WorkshopMigrationLedgerApi {
  ensureMigrationLedger(db: WorkshopPersistence): Promise<void>;
  readAppliedMigrations(
    db: WorkshopPersistence,
    namespace: string,
  ): Promise<WorkshopAppliedMigration[]>;
  applyNamespacedMigrations(
    db: WorkshopPersistence,
    namespace: string,
    migrations: readonly WorkshopNamespacedMigration[],
  ): Promise<WorkshopAppliedMigration[]>;
  recordMigrationAdoption(
    db: WorkshopPersistence,
    namespace: string,
    migration: WorkshopNamespacedMigration,
  ): Promise<void>;
  checksumMigration(migration: WorkshopNamespacedMigration): Promise<string>;
}

export class WorkshopMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkshopMigrationError';
  }
}

/**
 * Apply Workshop-owned schema migrations to any supported persistence adapter.
 * The host remains responsible for choosing the database and when migrations run.
 */
export async function applyWorkshopMigrations(
  persistence: WorkshopPersistence,
  ledgerApi?: WorkshopMigrationLedgerApi,
): Promise<WorkshopMigrationResult> {
  const ledger = ledgerApi ?? (await loadDiamondMigrationLedger());
  await ledger.ensureMigrationLedger(persistence);
  const previousVersion = await installedVersion(persistence);
  if (previousVersion > WORKSHOP_SCHEMA_VERSION) {
    throw new WorkshopMigrationError(
      `Workshop schema version ${previousVersion} is newer than supported version ${WORKSHOP_SCHEMA_VERSION}`,
    );
  }

  const migrations = workshopMigrations.map(({ id, sql }) => ({
    id,
    statements: splitStatements(sql),
  }));
  const before = await ledger.readAppliedMigrations(
    persistence,
    WORKSHOP_MIGRATION_NAMESPACE,
  );
  if (previousVersion > 0) {
    await validateLegacySchema(persistence, previousVersion);
    const installedMigrations = migrations.slice(0, previousVersion);
    for (const record of before) {
      const expected = installedMigrations.find(({ id }) => id === record.id);
      if (!expected) {
        throw new WorkshopMigrationError(
          `Workshop migration ledger contains unknown or newer migration ${record.id}`,
        );
      }
      if ((await ledger.checksumMigration(expected)) !== record.checksum) {
        throw new WorkshopMigrationError(
          `Checksum drift detected for ${WORKSHOP_MIGRATION_NAMESPACE}/${record.id}`,
        );
      }
    }
    const appliedIds = new Set(before.map(({ id }) => id));
    for (const migration of installedMigrations) {
      if (appliedIds.has(migration.id)) continue;
      await ledger.recordMigrationAdoption(
        persistence,
        WORKSHOP_MIGRATION_NAMESPACE,
        migration,
      );
    }
  }
  const records = await ledger.applyNamespacedMigrations(
    persistence,
    WORKSHOP_MIGRATION_NAMESPACE,
    migrations,
  );
  const actualVersion = await installedVersion(persistence);
  if (actualVersion !== WORKSHOP_SCHEMA_VERSION) {
    throw new WorkshopMigrationError(
      `Workshop migrations left schema at version ${actualVersion}; expected ${WORKSHOP_SCHEMA_VERSION}`,
    );
  }
  const previouslyApplied = new Set(before.map(({ id }) => id));
  const applied = records
    .filter(({ id, adopted }) => !adopted && !previouslyApplied.has(id))
    .map(({ id }) => id);

  return {
    previousVersion,
    version: WORKSHOP_SCHEMA_VERSION,
    applied,
  };
}

async function installedVersion(
  persistence: WorkshopPersistence,
): Promise<number> {
  const schemaTable = await persistence
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workshop_schema'",
    )
    .first<{ name: string }>();
  if (!schemaTable) return 0;

  const row = await persistence
    .prepare('SELECT version FROM workshop_schema WHERE singleton = 1')
    .first<{ version: number }>();
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new WorkshopMigrationError(
      'Workshop schema metadata is missing or invalid',
    );
  }
  return row.version;
}

async function loadDiamondMigrationLedger(): Promise<WorkshopMigrationLedgerApi> {
  try {
    return await import('@gnolith/diamond');
  } catch (cause) {
    throw new WorkshopMigrationError(
      'Applying Workshop migrations requires the @gnolith/diamond 0.4 migration ledger API',
      { cause },
    );
  }
}

async function validateLegacySchema(
  persistence: WorkshopPersistence,
  installed: number,
): Promise<void> {
  const expected = legacySchema(installed);
  const tables = await persistence
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'workshop_%' ORDER BY name",
    )
    .all<{ name: string; sql: string }>();
  const actualNames = (tables.results ?? []).map(({ name }) => name);
  const expectedNames = Object.keys(expected.tables).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw adoptionError(
      installed,
      `table set is ${actualNames.join(', ') || '(empty)'}; expected ${expectedNames.join(', ')}`,
    );
  }

  const schemaObjects = await persistence
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name",
    )
    .all<{
      type: 'trigger' | 'view';
      name: string;
      tbl_name: string;
      sql: string | null;
    }>();
  const unexpectedObjects = (schemaObjects.results ?? []).filter((object) => {
    if (object.type === 'trigger') {
      return (
        expectedNames.includes(object.tbl_name) ||
        /^workshop_/iu.test(object.name) ||
        referencesWorkshopTable(object.sql ?? '', expectedNames)
      );
    }
    return (
      /^workshop_/iu.test(object.name) ||
      referencesWorkshopTable(object.sql ?? '', expectedNames)
    );
  });
  if (unexpectedObjects.length > 0) {
    throw adoptionError(
      installed,
      `unexpected schema object ${unexpectedObjects
        .map(({ type, name }) => `${type} ${name}`)
        .join(', ')}`,
    );
  }

  for (const { name, sql } of tables.results ?? []) {
    const spec = expected.tables[name]!;
    const columns = await persistence
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all<ColumnInfo>();
    const actualColumns = (columns.results ?? []).map((column) => ({
      name: column.name,
      type: column.type.toUpperCase(),
      notNull: column.notnull === 1,
      defaultValue: normalizeDefault(column.dflt_value),
      primaryKey: column.pk,
    }));
    if (JSON.stringify(actualColumns) !== JSON.stringify(spec.columns)) {
      throw adoptionError(installed, `${name} columns do not match`);
    }
    const actualChecks = extractChecks(sql).sort();
    const expectedChecks = spec.checks.map(normalizeExpression).sort();
    if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
      throw adoptionError(installed, `${name} constraints do not match`);
    }

    const foreignKeys = await persistence
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
      .all<ForeignKeyInfo>();
    const actualForeignKeys = (foreignKeys.results ?? [])
      .map(
        (key) =>
          `${key.from}->${key.table}.${key.to}:${key.on_update.toUpperCase()}:${key.on_delete.toUpperCase()}:${key.match.toUpperCase()}`,
      )
      .sort();
    if (
      JSON.stringify(actualForeignKeys) !==
      JSON.stringify([...spec.foreignKeys].sort())
    ) {
      throw adoptionError(installed, `${name} foreign keys do not match`);
    }

    const indexList = await persistence
      .prepare(`PRAGMA index_list(${quoteIdentifier(name)})`)
      .all<IndexListInfo>();
    const constraintIndexes: string[] = [];
    for (const index of indexList.results ?? []) {
      if (index.origin === 'c') continue;
      const info = await persistence
        .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
        .all<{ seqno: number; name: string }>();
      const columnNames = (info.results ?? [])
        .sort((left, right) => left.seqno - right.seqno)
        .map(({ name: columnName }) => columnName)
        .join(',');
      constraintIndexes.push(
        `${index.origin}:${index.unique}:${index.partial}:${columnNames}`,
      );
    }
    if (
      JSON.stringify(constraintIndexes.sort()) !==
      JSON.stringify([...spec.constraintIndexes].sort())
    ) {
      throw adoptionError(
        installed,
        `${name} unique/primary indexes do not match`,
      );
    }
  }

  const explicitIndexes = await persistence
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'workshop_%' AND sql IS NOT NULL ORDER BY name",
    )
    .all<{ name: string; tbl_name: string; sql: string }>();
  const actualIndexes = Object.fromEntries(
    (explicitIndexes.results ?? []).map(({ name, tbl_name, sql }) => [
      name,
      `${tbl_name}:${normalizeSql(sql)}`,
    ]),
  );
  if (
    JSON.stringify(Object.entries(actualIndexes).sort()) !==
    JSON.stringify(Object.entries(expected.indexes).sort())
  ) {
    throw adoptionError(
      installed,
      'index ownership or definitions do not match',
    );
  }
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface LegacyTableSpec {
  columns: Array<{
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string | null;
    primaryKey: number;
  }>;
  checks: string[];
  foreignKeys: string[];
  constraintIndexes: string[];
}

function legacySchema(installed: number): {
  tables: Record<string, LegacyTableSpec>;
  indexes: Record<string, string>;
} {
  const column = (
    name: string,
    type: string,
    notNull = false,
    defaultValue: string | null = null,
    primaryKey = 0,
  ) => ({ name, type, notNull, defaultValue, primaryKey });
  const taskColumns = [
    column('id', 'TEXT', false, null, 1),
    column('idempotency_key', 'TEXT'),
    column('description', 'TEXT', true),
    column('role', 'TEXT'),
    column('prompt', 'TEXT', true),
    column('context_queries', 'TEXT', true, "'[]'"),
    column('memory_slugs', 'TEXT', true, "'[]'"),
    column('claimed', 'INTEGER', true, '0'),
    column('claimed_at', 'TEXT'),
    column('completed_at', 'TEXT'),
    column('archived_at', 'TEXT'),
    column('result', 'TEXT'),
    column('created_at', 'TEXT', true, 'current_timestamp'),
    column('updated_at', 'TEXT', true, 'current_timestamp'),
    ...(installed >= 2 ? [column('revision', 'INTEGER', true, '1')] : []),
  ];
  const memoryColumns = [
    column('slug', 'TEXT', false, null, 1),
    column('description', 'TEXT', true),
    column('content', 'TEXT', true),
    column('created_at', 'TEXT', true, 'current_timestamp'),
    column('updated_at', 'TEXT', true, 'current_timestamp'),
    ...(installed >= 2 ? [column('revision', 'INTEGER', true, '1')] : []),
  ];
  const tables: Record<string, LegacyTableSpec> = {
    workshop_memories: {
      columns: memoryColumns,
      checks: installed >= 2 ? ['revision >= 1'] : [],
      foreignKeys: [],
      constraintIndexes: ['pk:1:0:slug'],
    },
    workshop_schema: {
      columns: [
        column('singleton', 'INTEGER', false, null, 1),
        column('version', 'INTEGER', true),
        column('package_version', 'TEXT', true),
        column('updated_at', 'TEXT', true, 'current_timestamp'),
      ],
      checks: ['singleton = 1'],
      foreignKeys: [],
      constraintIndexes: [],
    },
    workshop_tasks: {
      columns: taskColumns,
      checks: [
        'json_valid(context_queries)',
        'json_valid(memory_slugs)',
        'claimed IN (0, 1)',
        '(claimed = 0 AND claimed_at IS NULL) OR (claimed = 1 AND claimed_at IS NOT NULL AND completed_at IS NULL AND archived_at IS NULL)',
        ...(installed >= 2 ? ['revision >= 1'] : []),
      ],
      foreignKeys: [],
      constraintIndexes: ['pk:1:0:id', 'u:1:0:idempotency_key'],
    },
  };
  if (installed >= 3) {
    tables.workshop_onboarding_runs = {
      columns: [
        column('key', 'TEXT', false, null, 1),
        column('plan_json', 'TEXT', true),
        column('principal_id', 'TEXT', true),
        column('state', 'TEXT', true, "'pending'"),
        column('lease_token', 'TEXT'),
        column('lease_expires_at', 'TEXT'),
        column('last_error_json', 'TEXT'),
        column('created_at', 'TEXT', true, 'current_timestamp'),
        column('updated_at', 'TEXT', true, 'current_timestamp'),
        column('completed_at', 'TEXT'),
      ],
      checks: [
        'json_valid(plan_json)',
        "state IN ('pending', 'running', 'retryable', 'operator_action_required', 'completed')",
        'last_error_json IS NULL OR json_valid(last_error_json)',
        "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state != 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)",
      ],
      foreignKeys: [],
      constraintIndexes: ['pk:1:0:key'],
    };
    tables.workshop_onboarding_steps = {
      columns: [
        column('run_key', 'TEXT', true, null, 1),
        column('step_key', 'TEXT', true),
        column('ordinal', 'INTEGER', true, null, 2),
        column('kind', 'TEXT', true),
        column('input_json', 'TEXT', true),
        column('state', 'TEXT', true, "'pending'"),
        column('attempts', 'INTEGER', true, '0'),
        column('receipt_json', 'TEXT'),
        column('error_json', 'TEXT'),
        column('created_at', 'TEXT', true, 'current_timestamp'),
        column('updated_at', 'TEXT', true, 'current_timestamp'),
      ],
      checks: [
        'ordinal >= 0',
        "kind IN ('entity', 'memory', 'task')",
        'json_valid(input_json)',
        "state IN ('pending', 'applying', 'completed', 'retryable', 'operator_action_required')",
        'attempts >= 0',
        'receipt_json IS NULL OR json_valid(receipt_json)',
        'error_json IS NULL OR json_valid(error_json)',
      ],
      foreignKeys: [
        'run_key->workshop_onboarding_runs.key:NO ACTION:CASCADE:NONE',
      ],
      constraintIndexes: ['pk:1:0:run_key,ordinal', 'u:1:0:run_key,step_key'],
    };
  }
  const indexDefinitions: Array<[string, string, string]> = [
    [
      'workshop_memories_updated_idx',
      'workshop_memories',
      'CREATE INDEX workshop_memories_updated_idx ON workshop_memories (updated_at DESC, slug)',
    ],
    [
      'workshop_tasks_role_idx',
      'workshop_tasks',
      'CREATE INDEX workshop_tasks_role_idx ON workshop_tasks (role, updated_at DESC, id)',
    ],
    [
      'workshop_tasks_state_idx',
      'workshop_tasks',
      'CREATE INDEX workshop_tasks_state_idx ON workshop_tasks (archived_at, completed_at, claimed, updated_at DESC, id)',
    ],
    [
      'workshop_tasks_updated_idx',
      'workshop_tasks',
      'CREATE INDEX workshop_tasks_updated_idx ON workshop_tasks (updated_at DESC, id)',
    ],
  ];
  if (installed >= 3) {
    indexDefinitions.push(
      [
        'workshop_onboarding_runs_state_idx',
        'workshop_onboarding_runs',
        'CREATE INDEX workshop_onboarding_runs_state_idx ON workshop_onboarding_runs (state, lease_expires_at, updated_at)',
      ],
      [
        'workshop_onboarding_steps_state_idx',
        'workshop_onboarding_steps',
        'CREATE INDEX workshop_onboarding_steps_state_idx ON workshop_onboarding_steps (run_key, state, ordinal)',
      ],
    );
  }
  const indexes: Record<string, string> = Object.fromEntries(
    indexDefinitions.map(([name, table, sql]) => [
      name,
      `${table}:${normalizeSql(sql)}`,
    ]),
  );
  return { tables, indexes };
}

function adoptionError(
  installed: number,
  detail: string,
): WorkshopMigrationError {
  return new WorkshopMigrationError(
    `Cannot adopt Workshop schema version ${installed}: ${detail}`,
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim().toLowerCase();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function normalizeSql(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function normalizeExpression(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, '').replaceAll('"', '');
}

function referencesWorkshopTable(
  sql: string,
  workshopTables: readonly string[],
): boolean {
  const normalized = sql.toLowerCase();
  return workshopTables.some((table) => {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'u').test(
      normalized,
    );
  });
}

function extractChecks(sql: string): string[] {
  const checks: string[] = [];
  const pattern = /\bcheck\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let quote: "'" | '"' | null = null;
    let index = start;
    for (; index < sql.length && depth > 0; index += 1) {
      const character = sql[index]!;
      if (quote) {
        if (character === quote && sql[index + 1] === quote) index += 1;
        else if (character === quote) quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0)
      throw new WorkshopMigrationError('Malformed CHECK constraint');
    checks.push(normalizeExpression(sql.slice(start, index - 1)));
  }
  return checks;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
