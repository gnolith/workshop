import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  bootstrapTaprootAuthorization,
  createInstallationDomainMutationGuard,
  createTaprootHostWriteCapability,
  initializeTaproot,
} from '@gnolith/taproot';
import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkshopMigrations } from '../src/migrations.js';
import type { AuthorizationContext } from '../src/protocol.js';
import { createWorkshopCore } from '../src/server/context.js';
import { createWorkshopSearchIntegrationV1 } from '../src/server/search.js';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from '../src/server/database.js';
import type { WorkshopAuthorizationAuthority } from '../src/server/authorization.js';
import {
  createTestCursorCodec,
  createTestKnowledgeOptions,
} from './helpers.js';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe('Workshop external search producers', () => {
  it('adopts more than 1,000 legacy rows in bounded pages and restores producers after restart', async () => {
    const path = join(
      tmpdir(),
      `workshop-search-volume-${randomUUID()}.sqlite`,
    );
    paths.push(path);
    let db = new NodeSqliteDatabase(path);
    const taproot = { baseIri: 'https://workshop-search-volume.test' };
    const installationId = 'installation:search-volume';
    const context: AuthorizationContext = {
      installationId,
      principalId: 'agent:volume-admin',
      activeWorkspaceId: 'workspace:search-volume',
      workspaceIds: ['workspace:search-volume'],
      capabilities: ['read', 'search:admin', 'admin'],
      authorizationRevision: 1,
    };
    const key = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    try {
      await initializeTaproot(db, taproot);
      let workshopDb = db as unknown as D1DatabaseLike;
      await applyWorkshopMigrations(workshopDb);
      let hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      await bootstrapTaprootAuthorization(
        db,
        taproot,
        hostCapability,
        installationId,
      );
      const visibility = JSON.stringify({
        version: 1,
        clauses: [
          [{ kind: 'workspace', workspaceId: 'workspace:search-volume' }],
        ],
      });
      for (let offset = 0; offset < 1_001; offset += 80) {
        const statements = Array.from(
          { length: Math.min(80, 1_001 - offset) },
          (_, index) => {
            const suffix = String(offset + index).padStart(4, '0');
            return workshopDb
              .prepare(
                `INSERT INTO workshop_tasks
                 (id, title, description, prompt, installation_id, owner_principal_id,
                  workspace_id, visibility_scope, authorization_revision)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                `legacy-${suffix}`,
                `Legacy task ${suffix}`,
                `Legacy searchable task ${suffix}`,
                `Process legacy task ${suffix}`,
                installationId,
                context.principalId,
                context.activeWorkspaceId,
                visibility,
                context.authorizationRevision,
              );
          },
        );
        await workshopDb.batch(statements);
      }
      let search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
      });
      await expect(
        search.task.producer.adoptLegacyPage(
          { ...context, capabilities: ['read'] },
          { limit: 100 },
        ),
      ).rejects.toBeDefined();
      let pages = 0;
      let complete = false;
      while (!complete) {
        const receipt = await search.task.producer.adoptLegacyPage(context, {
          limit: 100,
        });
        pages += 1;
        complete = receipt.complete;
        expect(pages).toBeLessThanOrEqual(11);
      }
      expect(pages).toBe(11);
      const registered = await workshopDb
        .prepare(
          `SELECT COUNT(*) AS count FROM taproot_unified_search_source_registry
           WHERE installation_id = ? AND source_kind = 'task'`,
        )
        .bind(installationId)
        .first<{ count: number }>();
      expect(registered?.count).toBe(1_001);

      await db.close();
      db = new NodeSqliteDatabase(path);
      workshopDb = db as unknown as D1DatabaseLike;
      hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
      });
      await expect(
        search.materialization.health(context),
      ).resolves.toBeDefined();
      await expect(
        search.task.producer.adoptLegacyPage(context, { limit: 100 }),
      ).rejects.toThrow('legacy adoption is not active');
      await expect(
        search.search(
          { text: 'legacy', limit: 10 },
          { ...context, installationId: 'installation:forged' },
        ),
      ).rejects.toBeDefined();
    } finally {
      await db.close();
    }
  });

  it('indexes, searches, hydrates, revises, and deletes a canonical Prompt on native SQLite', async () => {
    const path = join(tmpdir(), `workshop-search-${randomUUID()}.sqlite`);
    paths.push(path);
    const db = new NodeSqliteDatabase(path);
    const workshopDb = db as unknown as D1DatabaseLike;
    const taproot = { baseIri: 'https://workshop-search.test' };
    const installationId = 'installation:search-test';
    try {
      await initializeTaproot(db, taproot);
      await applyWorkshopMigrations(workshopDb);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      await bootstrapTaprootAuthorization(
        db,
        taproot,
        hostCapability,
        installationId,
      );
      const context: AuthorizationContext = {
        installationId,
        principalId: 'agent:prompt-author',
        activeWorkspaceId: 'workspace:search-test',
        workspaceIds: ['workspace:search-test'],
        capabilities: [
          'read',
          'task-write',
          'memory-write',
          'prompt-write',
          'search:admin',
          'admin',
        ],
        authorizationRevision: 1,
      };
      const search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
      });
      for (const domain of [search.task, search.memory, search.prompt]) {
        await expect(
          domain.producer.adoptLegacyPage(context, { limit: 100 }),
        ).resolves.toMatchObject({ complete: true });
      }
      const general = await createInstallationDomainMutationGuard(
        db,
        taproot,
        hostCapability,
        { domain: 'workshop.test', capability: 'read' },
      );
      const authority: WorkshopAuthorizationAuthority = {
        getInstallationAuthorizationState: () => general.readCurrentState(),
        async commitTaskMutation<T>(
          _db: D1DatabaseLike,
          actor: AuthorizationContext,
          statement: D1PreparedStatementLike,
        ) {
          if (!actor.capabilities.includes('task-write'))
            throw new Error('denied');
          return statement.first<T>();
        },
        async commitMemoryMutation<T>(
          _db: D1DatabaseLike,
          actor: AuthorizationContext,
          statement: D1PreparedStatementLike,
        ) {
          if (!actor.capabilities.includes('memory-write'))
            throw new Error('denied');
          return statement.first<T>();
        },
        async commitTaskBackfill(_db, _actor, _state, statements) {
          return _db.batch([...statements]);
        },
        async commitMemoryBackfill(_db, _actor, _state, statements) {
          return _db.batch([...statements]);
        },
        async commitCursorSnapshot(_db, actor, _state, statements) {
          await general.batchWithExpectedRevision(actor, statements);
          return _db.batch([...statements]);
        },
      };
      const core = createWorkshopCore({
        persistence: workshopDb,
        authorization: authority,
        knowledge: createTestKnowledgeOptions(),
        cursorCodec: createTestCursorCodec(),
        diamondHealth: async () => true,
        search,
      });
      const memory = await core.memories.upsert(
        'merge-guidance',
        {
          description: 'Merge guidance',
          content: 'Prefer atomic producer commits.',
        },
        context,
      );
      const memory2 = await core.memories.upsert(
        memory.slug,
        {
          description: memory.description,
          content: 'Prefer sealed atomic producer commits.',
          expectedRevision: memory.revision,
        },
        context,
      );
      expect(memory2.revision).toBe(2);
      expect(await core.memories.history(memory.slug, context)).toHaveLength(2);
      const idempotent = await core.memories.putIdempotent(
        'stable-guide',
        { description: 'Stable guide', content: 'Replay safely.' },
        context,
        'stable-guide-v1',
      );
      await expect(
        core.memories.putIdempotent(
          'stable-guide',
          { description: 'Stable guide', content: 'Replay safely.' },
          context,
          'stable-guide-v1',
        ),
      ).resolves.toMatchObject({ revision: 1 });
      const task = await core.tasks.create(
        {
          description: 'Review producer changes',
          prompt: 'Review atomically.',
        },
        context,
      );
      const editedTask = await core.tasks.update(
        task.id,
        { expectedRevision: 1, title: 'Review sealed producer changes' },
        context,
      );
      const claimedTask = await core.tasks.claim(editedTask.id, context);
      const completedTask = await core.tasks.complete(
        claimedTask.id,
        { kind: 'success', result: 'Reviewed.' },
        context,
      );
      expect(completedTask.revision).toBe(4);
      expect(await core.tasks.history(task.id, context)).toHaveLength(4);
      const archivedTask = await core.tasks.create(
        { description: 'Archive producer changes', prompt: 'Archive safely.' },
        context,
      );
      await expect(
        core.tasks.archive(archivedTask.id, { expectedRevision: 1 }, context),
      ).resolves.toMatchObject({ archivedAt: expect.any(String) });
      const abandonedTask = await core.tasks.create(
        {
          description: 'Reset abandoned producer claim',
          prompt: 'Reset safely.',
        },
        context,
      );
      await core.tasks.claim(abandonedTask.id, context);
      await expect(
        core.tasks.resetAbandonedClaim(
          abandonedTask.id,
          new Date(Date.now() + 60_000).toISOString(),
          context,
        ),
      ).resolves.toMatchObject({ claimed: false });
      await core.memories.delete(idempotent.slug, 1, context);
      const prompt = await core.prompts!.create(
        {
          name: 'merge-review',
          title: 'Merge review prompt',
          promptText: 'Compare overlapping work and recommend a safe merge.',
          scope: 'task-review',
          role: 'reviewer',
          variables: { taskIds: { type: 'array' } },
          priority: 20,
          order: 3,
        },
        context,
      );
      expect(prompt).toMatchObject({
        revision: 1,
        policyRevision: 1,
        active: true,
      });
      await search.materialization.startShadowRebuild(context);
      let completed = 0;
      for (let page = 0; page < 10; page += 1) {
        const receipt = await search.materialization.run(context, {
          maxJobs: 20,
          maxRebuildRoots: 20,
        });
        completed += receipt.completed;
      }
      expect(completed).toBeGreaterThanOrEqual(1);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      await search.materialization.activateReadyShadow(context);
      const first = await search.search(
        { text: 'overlapping work', kinds: ['prompt'], limit: 10 },
        context,
      );
      expect(first.results).toHaveLength(1);
      expect(first.results[0]).toMatchObject({
        kind: 'prompt',
        sourceId: prompt.id,
        sourceRevision: '1',
      });
      await expect(
        search.search(
          { text: 'overlapping work', kinds: ['prompt'], limit: 10 },
          {
            ...context,
            activeWorkspaceId: 'workspace:other',
            workspaceIds: ['workspace:other'],
          },
        ),
      ).resolves.toMatchObject({ results: [] });
      await expect(
        search.service.hydrate(first.results[0]!, context),
      ).resolves.toMatchObject({
        id: prompt.id,
        name: 'merge-review',
        revision: 1,
      });
      const changed = await core.prompts!.update(
        prompt.id,
        {
          expectedRevision: 1,
          promptText: 'Split unsafe work, then merge only compatible tasks.',
        },
        context,
      );
      expect(changed.revision).toBe(2);
      await expect(
        core.prompts!.update(
          prompt.id,
          { expectedRevision: 1, title: 'Stale write' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        search.service.hydrate(first.results[0]!, context),
      ).rejects.toBeDefined();
      expect(await core.prompts!.history(prompt.id, context)).toHaveLength(2);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      expect(
        (
          await search.search(
            { text: 'unsafe work', kinds: ['prompt'] },
            context,
          )
        ).results[0],
      ).toMatchObject({ sourceRevision: '2' });
      await core.prompts!.delete(prompt.id, 2, context);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      await expect(core.prompts!.get(prompt.id, context)).rejects.toMatchObject(
        {
          code: 'forbidden',
        },
      );
      expect(
        (
          await search.search(
            { text: 'unsafe work', kinds: ['prompt'] },
            context,
          )
        ).results,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
