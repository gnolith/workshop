import { afterEach, describe, expect, it } from 'vitest';
import { createWorkshopCore } from '../src/server/context.js';
import { createTestContext } from './helpers.js';

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe('monotonic Workshop revisions', () => {
  it('starts at one and increments once for each successful mutation', async () => {
    const { runtime, dispose } = await createTestContext();
    disposers.push(dispose);

    const memory = await runtime.memories.upsert('method', {
      description: 'Method',
      content: 'One',
    });
    expect(memory.revision).toBe(1);
    const changedMemory = await runtime.memories.upsert('method', {
      description: 'Method',
      content: 'Two',
      expectedRevision: memory.revision,
    });
    expect(changedMemory.revision).toBe(2);

    const task = await runtime.tasks.create({
      description: 'Task',
      prompt: 'Work',
    });
    expect(task.revision).toBe(1);
    const claimed = await runtime.tasks.claim(task.id);
    expect(claimed.revision).toBe(2);
    const changed = await runtime.tasks.update(task.id, {
      expectedRevision: claimed.revision,
      prompt: 'Changed',
    });
    expect(changed.revision).toBe(3);
    const completed = await runtime.tasks.complete(task.id, 'Done');
    expect(completed.revision).toBe(4);
  });

  it('makes revision authoritative when both compatibility tokens are supplied', async () => {
    const { runtime, dispose } = await createTestContext();
    disposers.push(dispose);
    const task = await runtime.tasks.create({
      description: 'Task',
      prompt: 'One',
    });
    const claimed = await runtime.tasks.claim(task.id);

    const changed = await runtime.tasks.update(task.id, {
      expectedRevision: claimed.revision,
      expectedUpdatedAt: task.updatedAt,
      prompt: 'Two',
    });
    expect(changed.prompt).toBe('Two');
    await expect(
      runtime.tasks.update(task.id, {
        expectedRevision: claimed.revision,
        expectedUpdatedAt: changed.updatedAt,
        prompt: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps legacy timestamp CAS safe when the clock is frozen', async () => {
    const { db, runtime, dispose } = await createTestContext();
    disposers.push(dispose);
    const frozen = new Date('2026-07-20T15:00:00.000Z');
    const core = createWorkshopCore({
      persistence: db,
      knowledge: runtime.knowledge,
      clock: () => frozen,
      executeSparql: async () => ({
        type: 'boolean',
        data: true,
        truncated: false,
      }),
    });
    const task = await core.tasks.create({
      description: 'Frozen',
      prompt: 'One',
    });
    const outcomes = await Promise.allSettled([
      core.tasks.update(task.id, {
        expectedUpdatedAt: task.updatedAt,
        prompt: 'Two',
      }),
      core.tasks.update(task.id, {
        expectedUpdatedAt: task.updatedAt,
        prompt: 'Three',
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect((await core.tasks.get(task.id)).updatedAt).not.toBe(task.updatedAt);

    const next = await core.tasks.create({
      description: 'Claim',
      prompt: 'One',
    });
    await core.tasks.claim(next.id);
    await expect(
      core.tasks.update(next.id, {
        expectedUpdatedAt: next.updatedAt,
        prompt: 'Stale pre-claim write',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects invalid revisions', async () => {
    const { runtime, dispose } = await createTestContext();
    disposers.push(dispose);
    const task = await runtime.tasks.create({
      description: 'Task',
      prompt: 'One',
    });
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_VALUE]) {
      await expect(
        runtime.tasks.update(task.id, {
          expectedRevision,
          prompt: 'Invalid',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
});
