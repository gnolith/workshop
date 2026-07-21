import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryHandler,
  createTaskClaimHandler,
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

describe('Worker-safe route factories', () => {
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
    const health = createWorkshopHealthHandler(value);
    const response = await health(
      request('https://site.test/api/workshop/health'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.not.toHaveProperty('tables');
  });
});
