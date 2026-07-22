import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { workshopPackage } from '../src/index.js';
import {
  applyWorkshopMigrations,
  WORKSHOP_SCHEMA_VERSION,
  workshopMigrations,
  type WorkshopAppliedMigration,
  type WorkshopMigrationLedgerApi,
  type WorkshopNamespacedMigration,
} from '../src/migrations.js';
import { createWorkshopCore } from '../src/server/context.js';
import type { WorkshopPersistence } from '../src/server/database.js';
import {
  createTestCursorCodec,
  createTestKnowledgeOptions,
  TEST_AUTHORIZATION,
} from './helpers.js';

describe('migration artifact integrity', () => {
  it('keeps the embedded migration byte-equivalent to the canonical SQL file', () => {
    expect(WORKSHOP_SCHEMA_VERSION).toBe(workshopMigrations.length);
    for (const migration of workshopMigrations) {
      const file = readFileSync(`migrations/${migration.id}.sql`, 'utf8')
        .replace(/\r\n/gu, '\n')
        .trim();
      expect(migration.sql).toBe(file);
      const digest = createHash('sha256').update(file).digest('hex');
      expect(migration.checksum).toBe(`sha256:${digest}`);
    }
    const packageManifest = JSON.parse(
      readFileSync('package.json', 'utf8'),
    ) as { version?: unknown };
    expect(packageManifest.version).toBe('0.3.2');
    expect(workshopPackage.version).toBe(packageManifest.version);
    expect(
      workshopMigrations
        .filter(({ id }) => id !== '0001_workshop')
        .map(({ sql }) => sql.includes("package_version = '0.2.2'")),
    ).toEqual([true, true, false, false]);
    expect(workshopMigrations[3]!.sql).toContain("package_version = '0.3.0'");
    expect(workshopMigrations[4]!.sql).toContain("package_version = '0.3.0'");
  });

  it('keeps migration identifiers unique and monotonically ordered', () => {
    const ids = workshopMigrations.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('initializes and idempotently reopens the schema through the portable persistence port', async () => {
    const fixture = await database();
    try {
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).resolves.toEqual({
        previousVersion: 0,
        version: WORKSHOP_SCHEMA_VERSION,
        applied: workshopMigrations.map(({ id }) => id),
      });
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).resolves.toEqual({
        previousVersion: WORKSHOP_SCHEMA_VERSION,
        version: WORKSHOP_SCHEMA_VERSION,
        applied: [],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('upgrades an existing version-one schema without replaying it', async () => {
    const fixture = await database();
    try {
      await execute(fixture.db, workshopMigrations[0]!.sql);
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).resolves.toEqual({
        previousVersion: 1,
        version: WORKSHOP_SCHEMA_VERSION,
        applied: workshopMigrations.slice(1).map(({ id }) => id),
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('adopts the exact historical version-two table semantics', async () => {
    const fixture = await database();
    try {
      await execute(fixture.db, workshopMigrations[0]!.sql);
      await execute(fixture.db, workshopMigrations[1]!.sql);
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).resolves.toEqual({
        previousVersion: 2,
        version: WORKSHOP_SCHEMA_VERSION,
        applied: workshopMigrations.slice(2).map(({ id }) => id),
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('makes freshly returned timestamp tokens usable for migrated rows', async () => {
    const fixture = await database();
    try {
      await execute(fixture.db, workshopMigrations[0]!.sql);
      await fixture.db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed, created_at, updated_at)
           VALUES ('legacy-task', 'Legacy', 'Before', '[]', '[]', 0,
                   '2026-07-20 12:00:00', '2026-07-20 12:00:00')`,
        )
        .run();
      await fixture.db
        .prepare(
          `INSERT INTO workshop_memories
           (slug, description, content, created_at, updated_at)
           VALUES ('legacy-memory', 'Legacy', 'Before',
                   '2026-07-20 12:00:00', '2026-07-20 12:00:00')`,
        )
        .run();
      await fixture.db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            claimed_at, created_at, updated_at)
           VALUES ('future-claim', 'Future claim', 'Do not reset', '[]', '[]', 1,
                   '2026-07-20 13:00:00', '2026-07-20 11:00:00',
                   '2026-07-20 13:00:00')`,
        )
        .run();
      await fixture.db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            claimed_at, created_at, updated_at)
           VALUES ('old-claim', 'Old claim', 'Reset this', '[]', '[]', 1,
                   '2026-07-20 11:30:00', '2026-07-20 11:00:00',
                   '2026-07-20 11:30:00')`,
        )
        .run();
      await fixture.db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            completed_at, archived_at, created_at, updated_at)
           VALUES ('legacy-finished', 'Finished', 'Already done', '[]', '[]', 0,
                   '2026-07-20 12:10:00', '2026-07-20 12:20:00',
                   '2026-07-20 11:00:00', '2026-07-20 12:20:00')`,
        )
        .run();
      await applyWorkshopMigrations(fixture.db, testLedger);

      await expect(
        fixture.db
          .prepare(
            `SELECT claimed_at AS claimedAt, created_at AS createdAt,
                    updated_at AS updatedAt
             FROM workshop_tasks WHERE id = 'future-claim'`,
          )
          .first(),
      ).resolves.toEqual({
        claimedAt: '2026-07-20T13:00:00.000Z',
        createdAt: '2026-07-20T11:00:00.000Z',
        updatedAt: '2026-07-20T13:00:00.000Z',
      });
      await expect(
        fixture.db
          .prepare(
            `SELECT completed_at AS completedAt, archived_at AS archivedAt
             FROM workshop_tasks WHERE id = 'legacy-finished'`,
          )
          .first(),
      ).resolves.toEqual({
        completedAt: '2026-07-20T12:10:00.000Z',
        archivedAt: '2026-07-20T12:20:00.000Z',
      });
      await expect(
        fixture.db
          .prepare(
            `SELECT created_at AS createdAt, updated_at AS updatedAt
             FROM workshop_memories WHERE slug = 'legacy-memory'`,
          )
          .first(),
      ).resolves.toEqual({
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:00:00.000Z',
      });
      const schema = await fixture.db
        .prepare(
          'SELECT updated_at AS updatedAt FROM workshop_schema WHERE singleton = 1',
        )
        .first<{ updatedAt: string }>();
      expect(schema?.updatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      const core = createWorkshopCore({
        persistence: fixture.db,
        authorization: {
          async getInstallationAuthorizationState() {
            return {
              installationId: TEST_AUTHORIZATION.installationId,
              authorizationRevision: TEST_AUTHORIZATION.authorizationRevision,
              searchGeneration: 1,
            };
          },
          async commitTaskMutation<T>(
            _db: import('../src/server/database.js').D1DatabaseLike,
            _context: import('../src/protocol.js').AuthorizationContext,
            mutation: import('../src/server/database.js').D1PreparedStatementLike,
          ) {
            return mutation.first<T>();
          },
          async commitMemoryMutation<T>(
            _db: import('../src/server/database.js').D1DatabaseLike,
            _context: import('../src/protocol.js').AuthorizationContext,
            mutation: import('../src/server/database.js').D1PreparedStatementLike,
          ) {
            return mutation.first<T>();
          },
          async commitTaskBackfill(_db, _context, _state, mutations) {
            return _db.batch([...mutations]);
          },
          async commitMemoryBackfill(_db, _context, _state, mutations) {
            return _db.batch([...mutations]);
          },
          async commitCursorSnapshot(_db, _context, _state, mutations) {
            return _db.batch([...mutations]);
          },
        },
        knowledge: createTestKnowledgeOptions(),
        cursorCodec: createTestCursorCodec(),
        diamondHealth: async () => true,
        clock: () => new Date('2026-07-20T12:00:01.000Z'),
      });

      for (const taskId of ['future-claim', 'old-claim', 'legacy-task']) {
        await expect(
          core.tasks.get(taskId, TEST_AUTHORIZATION),
        ).rejects.toMatchObject({
          code: 'forbidden',
          message: 'Authorization denied',
        });
      }
      await expect(
        core.memories.get('legacy-memory', TEST_AUTHORIZATION),
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: 'Authorization denied',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('fails closed on recorded checksum drift', async () => {
    const fixture = await database();
    try {
      await applyWorkshopMigrations(fixture.db, testLedger);
      migrationRecords.get(fixture.db)![1]!.checksum = 'tampered';
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).rejects.toThrow(
        'Checksum drift detected for @gnolith/workshop/0002_revisions',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('refuses to adopt an incomplete legacy schema', async () => {
    const fixture = await database();
    try {
      await fixture.db
        .prepare(
          `CREATE TABLE workshop_schema (
             singleton INTEGER PRIMARY KEY,
             version INTEGER NOT NULL,
             package_version TEXT NOT NULL,
             updated_at TEXT NOT NULL
           )`,
        )
        .run();
      await fixture.db
        .prepare(
          "INSERT INTO workshop_schema VALUES (1, 1, '0.1.0', CURRENT_TIMESTAMP)",
        )
        .run();
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).rejects.toThrow(
        'table set is workshop_schema; expected workshop_memories, workshop_schema, workshop_tasks',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects legacy schema metadata drift without recording adoption', async () => {
    const fixture = await database();
    try {
      await execute(fixture.db, workshopMigrations[0]!.sql);
      await fixture.db
        .prepare(
          "UPDATE workshop_schema SET package_version = 'tampered' WHERE singleton = 1",
        )
        .run();
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).rejects.toThrow('Workshop schema metadata is missing or invalid');
      expect(migrationRecords.get(fixture.db) ?? []).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects singleton and schema-version tampering without recording adoption', async () => {
    for (const tamper of [
      'UPDATE workshop_schema SET version = 2 WHERE singleton = 1',
      'PRAGMA ignore_check_constraints = ON; UPDATE workshop_schema SET singleton = 2 WHERE singleton = 1',
    ]) {
      const fixture = await database();
      try {
        await execute(fixture.db, workshopMigrations[0]!.sql);
        await execute(fixture.db, tamper);
        await expect(
          applyWorkshopMigrations(fixture.db, testLedger),
        ).rejects.toThrow('Workshop schema metadata is missing or invalid');
        expect(migrationRecords.get(fixture.db) ?? []).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    }
  });

  it('refuses to adopt structurally drifted legacy columns and indexes', async () => {
    const columnFixture = await database();
    try {
      await execute(columnFixture.db, workshopMigrations[0]!.sql);
      await columnFixture.db
        .prepare('ALTER TABLE workshop_memories ADD COLUMN unexpected TEXT')
        .run();
      await expect(
        applyWorkshopMigrations(columnFixture.db, testLedger),
      ).rejects.toThrow('workshop_memories columns do not match');
    } finally {
      await columnFixture.dispose();
    }

    const indexFixture = await database();
    try {
      await execute(indexFixture.db, workshopMigrations[0]!.sql);
      await indexFixture.db
        .prepare('DROP INDEX workshop_tasks_updated_idx')
        .run();
      await expect(
        applyWorkshopMigrations(indexFixture.db, testLedger),
      ).rejects.toThrow('index ownership or definitions do not match');
    } finally {
      await indexFixture.dispose();
    }
  });

  it('rejects hidden/generated columns and constraint-index collation drift without stamping adoption', async () => {
    const generatedFixture = await database();
    try {
      await execute(generatedFixture.db, workshopMigrations[0]!.sql);
      await generatedFixture.db
        .prepare(
          `ALTER TABLE workshop_memories
           ADD COLUMN derived_slug TEXT
           GENERATED ALWAYS AS (upper(slug)) VIRTUAL`,
        )
        .run();
      await expect(
        applyWorkshopMigrations(generatedFixture.db, testLedger),
      ).rejects.toThrow('workshop_memories columns do not match');
      expect(migrationRecords.get(generatedFixture.db) ?? []).toEqual([]);
    } finally {
      await generatedFixture.dispose();
    }

    const collationFixture = await database();
    try {
      const collatedSchema = workshopMigrations[0]!.sql.replace(
        'id TEXT PRIMARY KEY,',
        'id TEXT PRIMARY KEY COLLATE NOCASE,',
      );
      expect(collatedSchema).not.toBe(workshopMigrations[0]!.sql);
      await execute(collationFixture.db, collatedSchema);
      await expect(
        applyWorkshopMigrations(collationFixture.db, testLedger),
      ).rejects.toThrow('workshop_tasks unique/primary indexes do not match');
      expect(migrationRecords.get(collationFixture.db) ?? []).toEqual([]);
    } finally {
      await collationFixture.dispose();
    }
  });

  it('rejects exact table and foreign-key semantic drift without stamping adoption', async () => {
    const tableFixture = await database();
    try {
      const replaceConflictSchema = workshopMigrations[0]!.sql.replace(
        'id TEXT PRIMARY KEY,',
        'id TEXT PRIMARY KEY ON CONFLICT REPLACE,',
      );
      expect(replaceConflictSchema).not.toBe(workshopMigrations[0]!.sql);
      await execute(tableFixture.db, replaceConflictSchema);
      await expect(
        applyWorkshopMigrations(tableFixture.db, testLedger),
      ).rejects.toThrow('workshop_tasks table semantics do not match');
      expect(migrationRecords.get(tableFixture.db) ?? []).toEqual([]);
    } finally {
      await tableFixture.dispose();
    }

    const foreignKeyFixture = await database();
    try {
      await execute(foreignKeyFixture.db, workshopMigrations[0]!.sql);
      await execute(foreignKeyFixture.db, workshopMigrations[1]!.sql);
      const deferredForeignKeySchema = workshopMigrations[2]!.sql.replace(
        'ON DELETE CASCADE,',
        'ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,',
      );
      expect(deferredForeignKeySchema).not.toBe(workshopMigrations[2]!.sql);
      await execute(foreignKeyFixture.db, deferredForeignKeySchema);
      await expect(
        applyWorkshopMigrations(foreignKeyFixture.db, testLedger),
      ).rejects.toThrow(
        'workshop_onboarding_steps table semantics do not match',
      );
      expect(migrationRecords.get(foreignKeyFixture.db) ?? []).toEqual([]);
    } finally {
      await foreignKeyFixture.dispose();
    }
  });

  it('refuses behavior-changing triggers and views with arbitrary names', async () => {
    const triggerFixture = await database();
    try {
      await execute(triggerFixture.db, workshopMigrations[0]!.sql);
      await triggerFixture.db
        .prepare(
          `CREATE TRIGGER mutate_task_behavior
           AFTER UPDATE ON workshop_tasks
           BEGIN
             SELECT 1;
           END`,
        )
        .run();
      await expect(
        applyWorkshopMigrations(triggerFixture.db, testLedger),
      ).rejects.toThrow(
        'unexpected schema object trigger mutate_task_behavior',
      );
    } finally {
      await triggerFixture.dispose();
    }

    const hostTriggerFixture = await database();
    try {
      await execute(hostTriggerFixture.db, workshopMigrations[0]!.sql);
      await hostTriggerFixture.db
        .prepare(
          `CREATE TABLE host_events (
             task_id TEXT NOT NULL
           )`,
        )
        .run();
      await hostTriggerFixture.db
        .prepare(
          `CREATE TRIGGER propagate_host_event
           AFTER INSERT ON host_events
           BEGIN
             DELETE FROM workshop_tasks WHERE id = NEW.task_id;
           END`,
        )
        .run();
      await expect(
        applyWorkshopMigrations(hostTriggerFixture.db, testLedger),
      ).rejects.toThrow(
        'unexpected schema object trigger propagate_host_event',
      );
    } finally {
      await hostTriggerFixture.dispose();
    }

    const viewFixture = await database();
    try {
      await execute(viewFixture.db, workshopMigrations[0]!.sql);
      await viewFixture.db
        .prepare(
          `CREATE VIEW public_task_projection AS
           SELECT id, updated_at FROM workshop_tasks`,
        )
        .run();
      await expect(
        applyWorkshopMigrations(viewFixture.db, testLedger),
      ).rejects.toThrow('unexpected schema object view public_task_projection');
    } finally {
      await viewFixture.dispose();
    }
  });

  it('rejects a weakened authorization migration without stamping adoption', async () => {
    const fixture = await database();
    try {
      for (const migration of workshopMigrations.slice(0, 3))
        await execute(fixture.db, migration.sql);
      const weakened = workshopMigrations[3]!.sql.replace(
        'AND visibility_scope IS NOT NULL AND authorization_revision IS NOT NULL)',
        'AND authorization_revision IS NOT NULL)',
      );
      expect(weakened).not.toBe(workshopMigrations[3]!.sql);
      await execute(fixture.db, weakened);
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).rejects.toThrow('workshop_memories constraints do not match');
      expect(migrationRecords.get(fixture.db) ?? []).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('resumes a partially recorded legacy adoption without replaying schema SQL', async () => {
    const fixture = await database();
    try {
      for (const migration of workshopMigrations) {
        await execute(fixture.db, migration.sql);
      }
      await testLedger.ensureMigrationLedger(fixture.db);
      await testLedger.recordMigrationAdoption(
        fixture.db,
        '@gnolith/workshop',
        plan(workshopMigrations[0]!),
      );
      await expect(
        applyWorkshopMigrations(fixture.db, testLedger),
      ).resolves.toEqual({
        previousVersion: WORKSHOP_SCHEMA_VERSION,
        version: WORKSHOP_SCHEMA_VERSION,
        applied: [],
      });
      expect(migrationRecords.get(fixture.db)).toHaveLength(
        WORKSHOP_SCHEMA_VERSION,
      );
      expect(
        migrationRecords.get(fixture.db)?.every(({ adopted }) => adopted),
      ).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});

async function database(): Promise<{
  db: WorkshopPersistence;
  dispose: () => Promise<void>;
}> {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-20',
    d1Databases: { DB: `workshop-migrations-${crypto.randomUUID()}` },
  });
  return {
    db: (await miniflare.getD1Database('DB')) as unknown as WorkshopPersistence,
    dispose: () => miniflare.dispose(),
  };
}

async function execute(db: WorkshopPersistence, sql: string): Promise<void> {
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement));
  await db.batch(statements);
}

const migrationRecords = new WeakMap<
  WorkshopPersistence,
  WorkshopAppliedMigration[]
>();

const testLedger: WorkshopMigrationLedgerApi = {
  async ensureMigrationLedger(db) {
    if (!migrationRecords.has(db)) migrationRecords.set(db, []);
  },
  async readAppliedMigrations(db, namespace) {
    return [...(migrationRecords.get(db) ?? [])].filter(
      (record) => record.namespace === namespace,
    );
  },
  async applyNamespacedMigrations(db, namespace, migrations) {
    const records = migrationRecords.get(db) ?? [];
    validate(records, namespace, migrations);
    for (const migration of migrations) {
      if (records.some(({ id }) => id === migration.id)) continue;
      await execute(db, migration.statements.join(';\n'));
      records.push(record(namespace, migration, false));
    }
    migrationRecords.set(db, records);
    validate(records, namespace, migrations);
    return [...records];
  },
  async recordMigrationAdoption(db, namespace, migration) {
    const records = migrationRecords.get(db) ?? [];
    if (!records.some(({ id }) => id === migration.id)) {
      records.push(record(namespace, migration, true));
    }
    migrationRecords.set(db, records);
  },
  async checksumMigration(migration) {
    return checksum(migration);
  },
};

function record(
  namespace: string,
  migration: WorkshopNamespacedMigration,
  adopted: boolean,
): WorkshopAppliedMigration {
  return {
    namespace,
    id: migration.id,
    checksum: checksum(migration),
    adopted,
    appliedAt: new Date().toISOString(),
  };
}

function checksum(migration: WorkshopNamespacedMigration): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ id: migration.id, statements: migration.statements }),
    )
    .digest('hex');
}

function plan(migration: (typeof workshopMigrations)[number]) {
  return {
    id: migration.id,
    statements: migration.sql
      .split(/;\s*(?:\r?\n|$)/u)
      .map((statement) => statement.trim())
      .filter(Boolean),
  };
}

function validate(
  records: WorkshopAppliedMigration[],
  namespace: string,
  migrations: readonly WorkshopNamespacedMigration[],
): void {
  for (const applied of records) {
    const expected = migrations.find(({ id }) => id === applied.id);
    if (!expected || checksum(expected) !== applied.checksum) {
      throw new Error(`Checksum drift detected for ${namespace}/${applied.id}`);
    }
  }
}
