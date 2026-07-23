import { afterEach, describe, expect, it } from 'vitest';
import type { WorkshopPrincipal } from '../src/protocol.js';
import { createWorkshopCore } from '../src/server/context.js';
import type { WorkshopAuthorizationAuthority } from '../src/server/authorization.js';
import {
  createTestContext,
  createTestKnowledgeOptions,
  TEST_AUTHORIZATION,
} from './helpers.js';

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function setup() {
  const fixture = await createTestContext();
  disposers.push(fixture.dispose);
  return fixture;
}

function restartedCore(
  fixture: Awaited<ReturnType<typeof createTestContext>>,
  authorization: WorkshopAuthorizationAuthority = fixture.authorization,
) {
  return createWorkshopCore({
    persistence: fixture.db,
    authorization,
    knowledge: createTestKnowledgeOptions(),
    cursorCodec: fixture.cursorCodec,
    diamondHealth: async () => true,
    search: fixture.search,
  });
}

describe('authorized canonical revision history', () => {
  it('persists bounded newest-first Task and Memory history across core restart', async () => {
    const fixture = await setup();
    const task = await fixture.runtime.tasks.create(
      { description: 'Persistent task', prompt: 'Revision one' },
      TEST_AUTHORIZATION,
    );
    await fixture.runtime.tasks.update(
      task.id,
      { expectedRevision: task.revision, prompt: 'Revision two' },
      TEST_AUTHORIZATION,
    );
    const memory = await fixture.runtime.memories.upsert(
      'persistent-memory',
      { description: 'Persistent memory', content: 'Revision one' },
      TEST_AUTHORIZATION,
    );
    await fixture.runtime.memories.upsert(
      memory.slug,
      {
        description: memory.description,
        content: 'Revision two',
        expectedRevision: memory.revision,
      },
      TEST_AUTHORIZATION,
    );

    const restarted = restartedCore(fixture);
    await expect(
      restarted.tasks.history(task.id, TEST_AUTHORIZATION, { limit: 1 }),
    ).resolves.toMatchObject([
      { taskId: task.id, revision: 2, task: { prompt: 'Revision two' } },
    ]);
    await expect(
      restarted.memories.history(memory.slug, TEST_AUTHORIZATION, {
        limit: 2,
      }),
    ).resolves.toMatchObject([
      {
        memoryId: memory.slug,
        revision: 2,
        memory: { content: 'Revision two' },
      },
      {
        memoryId: memory.slug,
        revision: 1,
        memory: { content: 'Revision one' },
      },
    ]);
    await expect(
      restarted.tasks.history(task.id, TEST_AUTHORIZATION, { limit: 201 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('does not disclose historical secret canaries across policy changes or workspaces', async () => {
    const fixture = await setup();
    const ownerOnly = {
      version: 1 as const,
      clauses: [[{ kind: 'principal' as const, principalId: 'agent:test' }]],
    };
    const workspace = {
      version: 1 as const,
      clauses: [
        [{ kind: 'workspace' as const, workspaceId: 'workspace:test' }],
      ],
    };
    const task = await fixture.runtime.tasks.create(
      {
        description: 'Policy-changing task',
        prompt: 'TASK_HISTORY_SECRET_CANARY',
        visibility: ownerOnly,
      },
      TEST_AUTHORIZATION,
    );
    await fixture.runtime.tasks.update(
      task.id,
      {
        expectedRevision: task.revision,
        prompt: 'Redacted current task',
        visibility: workspace,
      },
      TEST_AUTHORIZATION,
    );
    const memory = await fixture.runtime.memories.upsert(
      'policy-changing-memory',
      {
        description: 'Policy-changing memory',
        content: 'MEMORY_HISTORY_SECRET_CANARY',
        visibility: ownerOnly,
      },
      TEST_AUTHORIZATION,
    );
    await fixture.runtime.memories.upsert(
      memory.slug,
      {
        description: memory.description,
        content: 'Redacted current memory',
        expectedRevision: memory.revision,
        visibility: workspace,
      },
      TEST_AUTHORIZATION,
    );
    const sameWorkspaceReader: WorkshopPrincipal = {
      ...TEST_AUTHORIZATION,
      principalId: 'agent:reader',
      capabilities: ['read'],
    };
    const otherWorkspaceReader: WorkshopPrincipal = {
      ...sameWorkspaceReader,
      activeWorkspaceId: 'workspace:other',
      workspaceIds: ['workspace:other'],
    };

    await expect(
      fixture.runtime.tasks.history(task.id, sameWorkspaceReader),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.runtime.memories.history(memory.slug, sameWorkspaceReader),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.runtime.tasks.history(task.id, otherWorkspaceReader),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.runtime.memories.history(memory.slug, otherWorkspaceReader),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechecks live authorization immediately before returning hydrated content', async () => {
    const fixture = await setup();
    const task = await fixture.runtime.tasks.create(
      { description: 'Revocation race', prompt: 'Never return after revoke' },
      TEST_AUTHORIZATION,
    );
    let reads = 0;
    const revokingAuthorization: WorkshopAuthorizationAuthority = {
      ...fixture.authorization,
      async getInstallationAuthorizationState() {
        reads += 1;
        return {
          installationId: TEST_AUTHORIZATION.installationId,
          authorizationRevision: reads < 3 ? 1 : 2,
          searchGeneration: 1,
        };
      },
    };
    const restarted = restartedCore(fixture, revokingAuthorization);

    await expect(
      restarted.tasks.history(task.id, TEST_AUTHORIZATION),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(reads).toBe(3);
  });

  it('fails closed when persisted revision identity is not canonical', async () => {
    const fixture = await setup();
    const memory = await fixture.runtime.memories.upsert(
      'tamper-canary',
      { description: 'Tamper canary', content: 'Canonical content' },
      TEST_AUTHORIZATION,
    );
    await fixture.db
      .prepare(
        `UPDATE workshop_memory_revisions
         SET snapshot_json = json_set(snapshot_json, '$.slug', 'wrong-memory')
         WHERE installation_id = ? AND memory_id = ? AND revision = 1`,
      )
      .bind(TEST_AUTHORIZATION.installationId, memory.slug)
      .run();

    await expect(
      fixture.runtime.memories.history(memory.slug, TEST_AUTHORIZATION),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
