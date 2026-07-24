import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type {
  MigrationLedgerBackup,
  MigrationLedgerOwnerHandle,
  MigrationLedgerSlice,
} from '@gnolith/diamond';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkshopBackupApi,
  createWorkshopOwnerHandlesV1,
} from '../src/backup.js';
import { applyWorkshopMigrations } from '../src/migrations.js';
import type { D1DatabaseLike } from '../src/server/database.js';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe('Workshop owner backup handle factory', () => {
  it('exports, inspects, and restores owner state without exposing table knowledge', async () => {
    const installationId = 'installation:backup-owner';
    const source = await database();
    const destination = await database();
    try {
      await applyWorkshopMigrations(source.db);
      await applyWorkshopMigrations(destination.db);
      await source.db
        .prepare(
          `INSERT INTO workshop_tasks (
             id, idempotency_key, description, prompt, context_queries, memory_slugs, claimed,
             installation_id, owner_principal_id, workspace_id,
             visibility_scope, authorization_revision, title, objective,
             constraints_json, acceptance_criteria_json, relationships_json,
             outcome_kind, language, attribution_json, policy_revision,
             revision, completed_at, result, created_at, updated_at
           ) VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?, ?, ?, 1, ?, NULL, '[]',
                     '[]', '[]', 'success', 'en', '{}', 1, 2, ?, ?, ?, ?)`,
        )
        .bind(
          'backup-task',
          'installation:backup-owner\u0000workspace:owner\u0000principal:owner\u0000create-once',
          'Back up this task',
          'Restore it safely',
          installationId,
          'principal:owner',
          'workspace:owner',
          JSON.stringify({
            version: 1,
            clauses: [[{ kind: 'workspace', workspaceId: 'workspace:owner' }]],
          }),
          'Back up this task',
          '2026-07-23T12:05:00.000Z',
          'completed exactly once',
          '2026-07-23T12:00:00.000Z',
          '2026-07-23T12:05:00.000Z',
        )
        .run();
      await source.db.batch([
        source.db
          .prepare(
            `INSERT INTO workshop_task_revisions (
               task_id, revision, snapshot_json, actor_principal_id, event_id, created_at
             ) VALUES (?, 1, ?, ?, ?, ?), (?, 2, ?, ?, ?, ?)`,
          )
          .bind(
            'backup-task',
            JSON.stringify({ id: 'backup-task', revision: 1 }),
            'principal:owner',
            'event:backup-created',
            '2026-07-23T12:00:00.000Z',
            'backup-task',
            JSON.stringify({
              id: 'backup-task',
              revision: 2,
              result: 'completed exactly once',
            }),
            'principal:owner',
            'event:backup-completed',
            '2026-07-23T12:05:00.000Z',
          ),
        source.db
          .prepare(
            `INSERT INTO workshop_task_lease_receipts (
               installation_id, principal_id, idempotency_key, task_id,
               operation, expected_revision, resulting_revision,
               receipt_json, created_at, request_digest
             ) VALUES (?, ?, ?, ?, 'complete', 1, 2, ?, ?, ?)`,
          )
          .bind(
            installationId,
            'principal:owner',
            'complete-once',
            'backup-task',
            JSON.stringify({
              id: 'backup-task',
              revision: 2,
              result: 'completed exactly once',
            }),
            '2026-07-23T12:05:00.000Z',
            'd'.repeat(64),
          ),
      ]);

      const sourceApi = createWorkshopBackupApi({
        ...createWorkshopOwnerHandlesV1(
          ownerOptions(source.db, installationId, 'connection:source'),
        ),
        schemaVersion: 11,
        clock: () => new Date('2026-07-23T13:00:00.000Z'),
      });
      const backup = await sourceApi.exportBackup(installationId);
      await expect(sourceApi.inspectBackup(backup)).resolves.toMatchObject({
        valid: true,
        installationId,
        legacy: { taskCount: 1 },
      });
      const tampered = structuredClone(backup) as {
        sections: {
          workshop: {
            tables: Record<string, Array<Record<string, unknown>>>;
          };
        };
      };
      const tamperedTask =
        tampered.sections.workshop.tables.workshop_tasks?.[0];
      if (tamperedTask)
        tamperedTask['title") VALUES (?); DELETE FROM workshop_tasks; --'] =
          'unsafe';
      await expect(sourceApi.inspectBackup(tampered)).rejects.toMatchObject({
        code: 'validation_failed',
      });

      const destinationApi = createWorkshopBackupApi({
        ...createWorkshopOwnerHandlesV1(
          ownerOptions(destination.db, installationId, 'connection:target'),
        ),
        schemaVersion: 11,
        clock: () => new Date('2026-07-23T14:00:00.000Z'),
      });
      await destination.db
        .prepare(
          `INSERT INTO workshop_tasks (
             id, idempotency_key, description, prompt, context_queries,
             memory_slugs, claimed, installation_id, owner_principal_id,
             workspace_id, visibility_scope, authorization_revision, title,
             constraints_json, acceptance_criteria_json, relationships_json,
             language, attribution_json, policy_revision, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?, ?, ?, 1, ?, '[]',
                     '[]', '[]', 'en', '{}', 1, 1, ?, ?)`,
        )
        .bind(
          'dry-run-collision',
          'installation:backup-owner\u0000workspace:owner\u0000principal:owner\u0000create-once',
          'Dry-run placeholder',
          'Must be replaced',
          installationId,
          'principal:owner',
          'workspace:owner',
          JSON.stringify({
            version: 1,
            clauses: [[{ kind: 'workspace', workspaceId: 'workspace:owner' }]],
          }),
          'Dry-run placeholder',
          '2026-07-23T13:30:00.000Z',
          '2026-07-23T13:30:00.000Z',
        )
        .run();
      await expect(destinationApi.importBackup(backup)).resolves.toMatchObject({
        valid: true,
        legacy: { taskCount: 1 },
      });
      await expect(destinationApi.importBackup(backup)).resolves.toMatchObject({
        valid: true,
        legacy: { taskCount: 1 },
      });
      await expect(
        destination.db
          .prepare(
            `SELECT installation_id, title FROM workshop_tasks WHERE id = ?`,
          )
          .bind('backup-task')
          .first(),
      ).resolves.toEqual({
        installation_id: installationId,
        title: 'Back up this task',
      });
      await expect(
        destination.db
          .prepare(
            `SELECT id, revision, outcome_kind, result
             FROM workshop_tasks WHERE installation_id = ?`,
          )
          .bind(installationId)
          .all(),
      ).resolves.toMatchObject({
        results: [
          {
            id: 'backup-task',
            revision: 2,
            outcome_kind: 'success',
            result: 'completed exactly once',
          },
        ],
        success: true,
      });
      await expect(
        destination.db
          .prepare(
            `SELECT operation, expected_revision, resulting_revision,
                    request_digest, receipt_json
             FROM workshop_task_lease_receipts
             WHERE installation_id = ? AND idempotency_key = ?`,
          )
          .bind(installationId, 'complete-once')
          .first(),
      ).resolves.toEqual({
        operation: 'complete',
        expected_revision: 1,
        resulting_revision: 2,
        request_digest: 'd'.repeat(64),
        receipt_json: JSON.stringify({
          id: 'backup-task',
          revision: 2,
          result: 'completed exactly once',
        }),
      });

      const inconsistent = structuredClone(backup) as {
        sections: {
          workshop: {
            tables: Record<string, Array<Record<string, unknown>>>;
          };
        };
      };
      inconsistent.sections.workshop.tables.workshop_tasks?.push({
        ...inconsistent.sections.workshop.tables.workshop_tasks[0],
        id: 'duplicate-idempotency',
      });
      await expect(
        destinationApi.inspectBackup(inconsistent),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    } finally {
      await source.close();
      await destination.close();
    }
  });
});

async function database() {
  const path = join(tmpdir(), `workshop-owner-backup-${randomUUID()}.sqlite`);
  paths.push(path);
  const native = new NodeSqliteDatabase(path);
  return {
    db: native as unknown as D1DatabaseLike,
    close: () => native.close(),
  };
}

function ownerOptions(
  db: D1DatabaseLike,
  installationId: string,
  connectionId: string,
) {
  const slice: MigrationLedgerSlice = {
    format: 'diamond-migration-ledger-slice-v1',
    namespace: '@gnolith/workshop',
    entries: [],
    canonicalSha256: 'a'.repeat(64),
  };
  const ledgerOwner: MigrationLedgerOwnerHandle = {
    ownerRegistrationId: 'owner:workshop',
    namespace: '@gnolith/workshop',
    installationId,
    connectionId,
  };
  const ledgerBackup: MigrationLedgerBackup = {
    exportNamespace: async () => slice,
    validateNamespace: async (_owner, value) => {
      if (JSON.stringify(value) !== JSON.stringify(slice))
        throw new Error('unexpected ledger slice');
    },
    restoreNamespace: async (_owner, value) => {
      if (JSON.stringify(value) !== JSON.stringify(slice))
        throw new Error('unexpected ledger slice');
    },
  };
  return {
    db,
    installationId,
    connectionId,
    registrationFingerprint: 'c'.repeat(64),
    ledgerBackup,
    ledgerOwner,
  };
}
