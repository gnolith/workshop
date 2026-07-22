import { afterEach, describe, expect, it } from 'vitest';
import { createWorkshopCore } from '../src/core.js';
import {
  createTestContext,
  createTestCursorCodec,
  createTestKnowledgeOptions,
  TEST_AUTHORIZATION,
} from './helpers.js';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

describe('Workshop core', () => {
  it('composes process-local services without HTTP authentication', async () => {
    const context = await createTestContext();
    disposals.push(context.dispose);
    let knowledgeAuthorization: unknown;

    const core = createWorkshopCore({
      persistence: context.db,
      authorization: context.authorization,
      knowledge: {
        ...createTestKnowledgeOptions(),
        authorizedReader: (_actor, source) => {
          knowledgeAuthorization = source;
          return {
            async getEntity() {
              return null;
            },
            async searchEntities() {
              return { items: [], cursor: null };
            },
          };
        },
      },
      cursorCodec: createTestCursorCodec(),
      diamondHealth: async () => true,
      createId: () => 'process-local-task',
    });

    expect(core.persistence).toBe(context.db);
    expect(context.runtime.db).toBe(context.db);
    expect(context.runtime.persistence).toBe(context.db);
    await core.knowledge.call(
      { name: 'search_entities', input: { query: 'same source' } },
      TEST_AUTHORIZATION,
    );
    expect(knowledgeAuthorization).toBe(context.authorization);

    await core.memories.upsert(
      'process-local',
      {
        description: 'Process-local guidance',
        content: 'Run without an HTTP transport.',
      },
      TEST_AUTHORIZATION,
    );
    const task = await core.tasks.create(
      {
        description: 'Run headlessly',
        prompt: 'Use the Workshop core directly.',
        memorySlugs: ['process-local'],
      },
      TEST_AUTHORIZATION,
    );

    await expect(
      core.tasks.get(task.id, TEST_AUTHORIZATION),
    ).resolves.toMatchObject({
      id: 'process-local-task',
      memorySlugs: ['process-local'],
    });
  });
});
