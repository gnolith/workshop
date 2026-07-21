import { describe, expect, it } from 'vitest';
import type { KnowledgeService } from '../src/protocol/knowledge.js';
import type { Memory } from '../src/protocol/memories.js';
import type { Task } from '../src/protocol/tasks.js';
import { OnboardingService } from '../src/server/onboarding.js';

describe('onboarding seed', () => {
  it('rolls back an incoherent seed when a host transaction is available', async () => {
    const state: { entities: unknown[]; memories: Memory[]; tasks: Task[] } = {
      entities: [],
      memories: [],
      tasks: [],
    };
    let knowledgeCalls = 0;
    const knowledge: KnowledgeService = {
      async call(call) {
        if (++knowledgeCalls === 2)
          throw new Error('simulated Taproot failure');
        const entity = { id: `Q${knowledgeCalls}`, ...call.input };
        state.entities.push(entity);
        return entity;
      },
      async health() {
        return true;
      },
    };
    const tasks = {
      async create(input: { description: string; prompt: string }) {
        const task = {
          id: 'task-1',
          ...input,
          contextQueries: [],
          memorySlugs: [],
          claimed: false,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
        } satisfies Task;
        state.tasks.push(task);
        return task;
      },
    };
    const memories = {
      async upsert(
        slug: string,
        input: { description: string; content: string },
      ) {
        const memory = {
          slug,
          ...input,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
        } satisfies Memory;
        state.memories.push(memory);
        return memory;
      },
    };
    const transaction = async <T>(operation: () => Promise<T>): Promise<T> => {
      const snapshot = {
        entities: [...state.entities],
        memories: [...state.memories],
        tasks: [...state.tasks],
      };
      try {
        return await operation();
      } catch (error) {
        state.entities.splice(0, state.entities.length, ...snapshot.entities);
        state.memories.splice(0, state.memories.length, ...snapshot.memories);
        state.tasks.splice(0, state.tasks.length, ...snapshot.tasks);
        throw error;
      }
    };
    const service = new OnboardingService(tasks, memories, knowledge, {
      transaction,
      isEmpty: () => true,
    });
    const plan = service.plan({
      key: 'new-site',
      topics: ['One', 'Two'],
      scopeBoundaries: 'Only cited evidence.',
    });
    await expect(
      service.apply(plan, 'owner', { expectedEmpty: true }),
    ).rejects.toThrow('simulated Taproot failure');
    expect(state).toEqual({ entities: [], memories: [], tasks: [] });
  });

  it('enforces the explicit expected-empty precondition before mutation', async () => {
    const service = new OnboardingService(
      { create: async () => Promise.reject(new Error('must not run')) },
      { upsert: async () => Promise.reject(new Error('must not run')) },
      { call: async () => Promise.reject(new Error('must not run')) },
      { isEmpty: () => false },
    );
    const plan = service.plan({ key: 'already-seeded', topics: ['Topic'] });
    await expect(
      service.apply(plan, 'owner', { expectedEmpty: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
