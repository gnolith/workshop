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
  const requiredTables = [
    'workshop_tasks',
    'workshop_memories',
    'workshop_schema',
    ...(installed >= 3
      ? ['workshop_onboarding_runs', 'workshop_onboarding_steps']
      : []),
  ];
  for (const name of requiredTables) {
    const row = await persistence
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .bind(name)
      .first<{ name: string }>();
    if (!row) {
      throw new WorkshopMigrationError(
        `Cannot adopt Workshop schema version ${installed}: missing table ${name}`,
      );
    }
  }
  if (installed >= 2) {
    for (const table of ['workshop_tasks', 'workshop_memories']) {
      const columns = await persistence
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>();
      if (!(columns.results ?? []).some(({ name }) => name === 'revision')) {
        throw new WorkshopMigrationError(
          `Cannot adopt Workshop schema version ${installed}: ${table}.revision is missing`,
        );
      }
    }
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
