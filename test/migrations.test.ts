import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
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
      await applyWorkshopMigrations(fixture.db, testLedger);
      const core = createWorkshopCore({
        persistence: fixture.db,
        knowledge: {
          async call() {
            throw new Error('not used');
          },
          async health() {
            return true;
          },
        },
        executeSparql: async () => ({
          type: 'boolean',
          data: true,
          truncated: false,
        }),
        clock: () => new Date('2026-07-20T12:00:01.000Z'),
      });

      const legacyMemory = await core.memories.get('legacy-memory');
      expect(legacyMemory.updatedAt).toBe('2026-07-20T12:00:00.000Z');
      await expect(
        core.memories.upsert('legacy-memory', {
          description: 'Legacy',
          content: 'After',
          expectedUpdatedAt: legacyMemory.updatedAt,
        }),
      ).resolves.toMatchObject({ content: 'After', revision: 2 });

      const legacyTask = await core.tasks.get('legacy-task');
      expect(legacyTask.updatedAt).toBe('2026-07-20T12:00:00.000Z');
      const updated = await core.tasks.update('legacy-task', {
        prompt: 'After',
        expectedUpdatedAt: legacyTask.updatedAt,
      });
      await expect(
        core.tasks.archive('legacy-task', {
          expectedUpdatedAt: updated.updatedAt,
        }),
      ).resolves.toMatchObject({ archivedAt: '2026-07-20T12:00:01.000Z' });
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
