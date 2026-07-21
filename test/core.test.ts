import { afterEach, describe, expect, it } from 'vitest';
import { createWorkshopCore } from '../src/core.js';
import { createTestContext } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

describe('Workshop core', () => {
  it('composes process-local services without HTTP authentication', async () => {
    const context = await createTestContext();
    disposals.push(context.dispose);

    const core = createWorkshopCore({
      persistence: context.db,
      executeSparql: async () => ({
        type: 'boolean',
        data: true,
        truncated: false,
      }),
      knowledge: {
        async call(call) {
          return call.input;
        },
        async health() {
          return true;
        },
      },
      createId: () => 'process-local-task',
    });

    expect(core.persistence).toBe(context.db);
    expect(context.runtime.db).toBe(context.db);
    expect(context.runtime.persistence).toBe(context.db);

    await core.memories.upsert('process-local', {
      description: 'Process-local guidance',
      content: 'Run without an HTTP transport.',
    });
    const task = await core.tasks.create({
      description: 'Run headlessly',
      prompt: 'Use the Workshop core directly.',
      memorySlugs: ['process-local'],
    });

    await expect(core.tasks.get(task.id)).resolves.toMatchObject({
      id: 'process-local-task',
      memorySlugs: ['process-local'],
    });
  });
});
