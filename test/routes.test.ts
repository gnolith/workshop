import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryHandler,
  createMemoryHistoryHandler,
  createTaskClaimHandler,
  createTaskHistoryHandler,
  createTasksHandler,
  createWorkshopHealthHandler,
  createWorkshopProbeHandler,
} from '../src/site.js';
import { createTestContext } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

async function runtime() {
  const context = await createTestContext();
  disposals.push(context.dispose);
  return context.runtime;
}

function request(
  url: string,
  method = 'GET',
  token?: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('Web route factories', () => {
  it('enforces server-side auth and maps task lifecycle routes', async () => {
    const value = await runtime();
    const tasks = createTasksHandler(value);
    expect(
      (await tasks(request('https://site.test/api/workshop/tasks'))).status,
    ).toBe(401);
    const createdResponse = await tasks(
      request('https://site.test/api/workshop/tasks', 'POST', 'writer', {
        description: 'Route task',
        prompt: 'Work',
      }),
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as { id: string };
    const claim = createTaskClaimHandler(value);
    expect(
      (
        await claim(
          request(
            `https://site.test/api/workshop/tasks/${created.id}/claim`,
            'POST',
            'reader',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await claim(
          request(
            `https://site.test/api/workshop/tasks/${created.id}/claim`,
            'POST',
            'writer',
          ),
        )
      ).status,
    ).toBe(200);
  });

  it('keeps memory mutations capability-scoped and diagnostics admin-only', async () => {
    const value = await runtime();
    const memory = createMemoryHandler(value);
    expect(
      (
        await memory(
          request(
            'https://site.test/api/workshop/memories/method',
            'PUT',
            'reader',
            { description: 'Method', content: 'Guidance' },
          ),
        )
      ).status,
    ).toBe(403);
    const probe = createWorkshopProbeHandler(value);
    expect(
      (
        await probe(
          request('https://site.test/api/workshop/probe', 'GET', 'writer'),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await probe(
          request('https://site.test/api/workshop/probe', 'GET', 'admin'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await probe(
          request('https://site.test/api/workshop/probe', 'POST', 'admin'),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await probe(
          request('https://site.test/api/workshop/probe', 'POST', 'writer'),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await probe(
          request('https://site.test/api/workshop/probe', 'POST', 'full'),
        )
      ).status,
    ).toBe(200);
    const health = createWorkshopHealthHandler(value);
    const response = await health(
      request('https://site.test/api/workshop/health'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.not.toHaveProperty('tables');
  });

  it('exposes bounded authorized Task and Memory history routes', async () => {
    const value = await runtime();
    const task = await value.tasks.create(
      { description: 'Route history', prompt: 'First' },
      {
        ...(await value.resolvePrincipal(
          request('https://site.test/api/workshop/tasks', 'GET', 'writer'),
        ))!,
      },
    );
    await value.tasks.update(
      task.id,
      { expectedRevision: task.revision, prompt: 'Second' },
      (await value.resolvePrincipal(
        request('https://site.test/api/workshop/tasks', 'GET', 'writer'),
      ))!,
    );
    const memory = await value.memories.upsert(
      'route-history',
      { description: 'Route history', content: 'First' },
      (await value.resolvePrincipal(
        request('https://site.test/api/workshop/memories', 'GET', 'writer'),
      ))!,
    );
    await value.memories.upsert(
      memory.slug,
      {
        description: memory.description,
        content: 'Second',
        expectedRevision: memory.revision,
      },
      (await value.resolvePrincipal(
        request('https://site.test/api/workshop/memories', 'GET', 'writer'),
      ))!,
    );
    const taskHistory = createTaskHistoryHandler(value);
    const memoryHistory = createMemoryHistoryHandler(value);

    expect(
      (
        await taskHistory(
          request(
            `https://site.test/api/workshop/tasks/${task.id}/history?limit=1`,
          ),
        )
      ).status,
    ).toBe(401);
    await expect(
      (
        await taskHistory(
          request(
            `https://site.test/api/workshop/tasks/${task.id}/history?limit=1`,
            'GET',
            'reader',
          ),
        )
      ).json(),
    ).resolves.toMatchObject([{ taskId: task.id, revision: 2 }]);
    await expect(
      (
        await memoryHistory(
          request(
            `https://site.test/api/workshop/memories/${memory.slug}/history?limit=1`,
            'GET',
            'reader',
          ),
        )
      ).json(),
    ).resolves.toMatchObject([{ memoryId: memory.slug, revision: 2 }]);
  });
});
