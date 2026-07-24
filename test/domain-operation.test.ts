import { describe, expect, it } from 'vitest';
import { createWorkshopDomainOperationPortV1 } from '../src/domain-operation.js';
import type { OperationCallContext } from '../src/operations.js';
import type { WorkshopCore } from '../src/server/context.js';

describe('Workshop domain operation port', () => {
  it('binds every Workshop-owned operation to an owner service', async () => {
    const calls: string[] = [];
    const value =
      (name: string, result: unknown = { name }) =>
      async () => {
        calls.push(name);
        return result;
      };
    const core = {
      tasks: {
        list: value('tasks.list'),
        search: value('tasks.search'),
        get: value('tasks.get'),
        create: value('tasks.create'),
        update: value('tasks.update'),
        updateWithLease: value('tasks.updateWithLease'),
        archive: value('tasks.archive'),
        claimLease: value('tasks.claimLease'),
        releaseLease: value('tasks.releaseLease'),
        completeLease: value('tasks.completeLease'),
        history: value('tasks.history', [{ revision: 1 }]),
      },
      packets: { get: value('packets.get') },
      memories: {
        list: value('memories.list'),
        get: value('memories.get'),
        putIdempotent: value('memories.putIdempotent'),
        delete: value('memories.delete', undefined),
        history: value('memories.history', [{ revision: 1 }]),
      },
      prompts: {
        list: value('prompts.list'),
        get: value('prompts.get'),
        create: value('prompts.create'),
        update: value('prompts.update'),
        delete: value('prompts.delete', undefined),
        history: value('prompts.history', [{ revision: 1 }]),
      },
    } as unknown as WorkshopCore;
    const port = createWorkshopDomainOperationPortV1(core);
    const context: OperationCallContext = {
      principal: {
        installationId: 'installation:test',
        principalId: 'principal:test',
        credentialId: 'credential:test',
        activeWorkspaceId: 'workspace:test',
        workspaceIds: ['workspace:test'],
        capabilities: ['read', 'task:write', 'memory:write', 'prompt:write'],
        authorizationRevision: 1,
      },
      requestId: 'request:test',
      signal: new AbortController().signal,
    };
    const cases = [
      ['list_tasks', {}],
      ['search_tasks', { text: 'task' }],
      ['get_task', { taskId: 'task:1' }],
      ['get_task_packet', { taskId: 'task:1' }],
      [
        'create_task',
        {
          idempotencyKey: 'create-task',
          description: 'Task',
          prompt: 'Do it',
        },
      ],
      ['update_task', { taskId: 'task:1', expectedRevision: 1, patch: {} }],
      [
        'update_task',
        {
          taskId: 'task:1',
          expectedRevision: 1,
          leaseToken: 'lease',
          patch: {},
        },
      ],
      ['archive_task', { taskId: 'task:1', expectedRevision: 1 }],
      ['claim_task', { taskId: 'task:1' }],
      [
        'release_task',
        {
          taskId: 'task:1',
          leaseToken: 'lease',
          expectedRevision: 1,
          idempotencyKey: 'release',
        },
      ],
      [
        'complete_task',
        {
          taskId: 'task:1',
          leaseToken: 'lease',
          expectedRevision: 1,
          idempotencyKey: 'complete',
          result: 'done',
        },
      ],
      ['task_history', { taskId: 'task:1' }],
      ['list_memories', {}],
      ['get_memory', { slug: 'memory' }],
      [
        'upsert_memory',
        {
          slug: 'memory',
          idempotencyKey: 'memory',
          description: 'Memory',
          content: 'Content',
        },
      ],
      [
        'delete_memory',
        { slug: 'memory', expectedRevision: 1, idempotencyKey: 'delete' },
      ],
      ['memory_history', { slug: 'memory' }],
      ['list_prompts', {}],
      ['get_prompt', { promptId: 'prompt:1' }],
      [
        'create_prompt',
        { idempotencyKey: 'prompt', name: 'Prompt', promptText: 'Text' },
      ],
      [
        'update_prompt',
        {
          promptId: 'prompt:1',
          expectedRevision: 1,
          idempotencyKey: 'update',
          patch: {},
        },
      ],
      [
        'delete_prompt',
        {
          promptId: 'prompt:1',
          expectedRevision: 1,
          idempotencyKey: 'delete',
        },
      ],
      ['prompt_history', { promptId: 'prompt:1' }],
    ] as const;
    for (const [name, input] of cases) await port.call(name, input, context);

    expect(calls).toEqual([
      'tasks.list',
      'tasks.search',
      'tasks.get',
      'packets.get',
      'tasks.create',
      'tasks.update',
      'tasks.updateWithLease',
      'tasks.archive',
      'tasks.claimLease',
      'tasks.releaseLease',
      'tasks.completeLease',
      'tasks.history',
      'memories.list',
      'memories.get',
      'memories.putIdempotent',
      'memories.delete',
      'memories.history',
      'prompts.list',
      'prompts.get',
      'prompts.create',
      'prompts.update',
      'prompts.delete',
      'prompts.history',
    ]);
  });

  it('fails closed before owner dispatch without live workspace grants', async () => {
    const port = createWorkshopDomainOperationPortV1({
      prompts: {},
    } as unknown as WorkshopCore);
    await expect(
      port.call(
        'list_tasks',
        {},
        {
          principal: {
            installationId: 'installation:test',
            principalId: 'principal:test',
            credentialId: 'credential:test',
            activeWorkspaceId: null,
            capabilities: ['read'],
            authorizationRevision: 1,
          },
          requestId: 'request:test',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
