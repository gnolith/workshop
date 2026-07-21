import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import type { Memory } from '../src/protocol/memories.js';
import type { Task } from '../src/protocol/tasks.js';
import { workshopMigrations } from '../src/migrations.js';
import type { D1DatabaseLike } from '../src/server/database.js';
import {
  OnboardingService,
  SqlOnboardingCheckpointStore,
  type OnboardingCheckpointStore,
} from '../src/server/onboarding.js';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

describe('resumable onboarding', () => {
  it('replays an effect after interruption without duplicating it', async () => {
    const harness = await createHarness();
    let failCheckpoint = true;
    const interruptedStore = new Proxy(harness.store, {
      get(target, property, receiver) {
        if (property === 'completeStep') {
          return async (
            ...args: Parameters<OnboardingCheckpointStore['completeStep']>
          ) => {
            if (failCheckpoint) {
              failCheckpoint = false;
              throw new Error('simulated process interruption');
            }
            return target.completeStep(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as OnboardingCheckpointStore;
    const interrupted = harness.service(interruptedStore);
    const plan = interrupted.plan({ key: 'resume-me', topics: ['One'] });

    await expect(interrupted.apply(plan, 'owner')).rejects.toThrow(
      'simulated process interruption',
    );
    harness.advance(10);
    const result = await harness.service().resume(plan.key, 'owner');

    expect(result).toMatchObject({
      state: 'completed',
      completedSteps: 2,
      totalSteps: 2,
    });
    expect(harness.entityEffects).toHaveLength(1);
    expect(result.steps[0]?.attempts).toBe(2);
  });

  it('exposes retryable progress and resumes from completed checkpoints', async () => {
    const harness = await createHarness();
    harness.failTaskOnce = true;
    const service = harness.service();
    const plan = service.plan({
      key: 'retry-me',
      topics: ['One'],
      scopeBoundaries: 'Only cited evidence.',
    });

    const partial = await service.apply(plan, 'owner');
    expect(partial).toMatchObject({
      state: 'retryable',
      retryable: true,
      completedSteps: 2,
      totalSteps: 3,
    });
    const completed = await service.resume(plan.key, 'owner');
    expect(completed).toMatchObject({
      state: 'completed',
      completedSteps: 3,
    });
    expect(harness.entityEffects).toHaveLength(1);
    expect(harness.memoryEffects).toHaveLength(1);
    expect(harness.taskEffects).toHaveLength(1);
  });

  it('rejects concurrent leases and same-key plans with different content', async () => {
    const harness = await createHarness();
    const service = harness.service();
    const plan = service.plan({ key: 'exclusive', topics: ['One'] });
    const planJson = JSON.stringify(plan, Object.keys(plan).sort());
    await harness.store.create(
      plan.key,
      planJson,
      'owner',
      [],
      harness.now().toISOString(),
    );
    expect(
      await harness.store.claim(
        plan.key,
        'first',
        harness.now().toISOString(),
        new Date(harness.now().getTime() + 60_000).toISOString(),
      ),
    ).toBe(true);
    expect(
      await harness.store.claim(
        plan.key,
        'second',
        harness.now().toISOString(),
        new Date(harness.now().getTime() + 60_000).toISOString(),
      ),
    ).toBe(false);

    await expect(
      service.apply(
        service.plan({ key: 'exclusive', topics: ['Two'] }),
        'owner',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('checks expected-empty only when creating the durable run', async () => {
    const harness = await createHarness();
    const service = harness.service(undefined, () => false);
    const plan = service.plan({ key: 'not-empty', topics: ['One'] });
    await expect(
      service.apply(plan, 'owner', { expectedEmpty: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await service.get(plan.key)).toBeNull();
  });

  it('does not allow a different principal to resume durable effects', async () => {
    const harness = await createHarness();
    harness.failTaskOnce = true;
    const service = harness.service();
    const plan = service.plan({ key: 'principal-bound', topics: ['One'] });
    await service.apply(plan, 'owner');
    await expect(service.resume(plan.key, 'intruder')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

async function createHarness() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-20',
    d1Databases: { DB: `onboarding-${crypto.randomUUID()}` },
  });
  disposals.push(() => miniflare.dispose());
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  for (const migration of workshopMigrations)
    await executeSql(db, migration.sql);
  const exists = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workshop_onboarding_runs'",
    )
    .first();
  if (!exists) {
    await executeSql(
      db,
      readFileSync('migrations/0003_resumable_onboarding.sql', 'utf8'),
    );
  }
  const store = new SqlOnboardingCheckpointStore(db);
  let tick = Date.parse('2026-07-20T00:00:00.000Z');
  const entityByKey = new Map<string, unknown>();
  const memoryByKey = new Map<string, Memory>();
  const taskByKey = new Map<string, Task>();
  const harness = {
    store,
    entityEffects: [] as string[],
    memoryEffects: [] as string[],
    taskEffects: [] as string[],
    failTaskOnce: false,
    now: () => new Date(tick),
    advance: (milliseconds: number) => {
      tick += milliseconds;
    },
    service(
      selectedStore: OnboardingCheckpointStore = store,
      isEmpty: (key: string) => boolean = () => true,
    ) {
      return new OnboardingService(
        {
          async create(input) {
            const key = input.idempotencyKey ?? '';
            if (harness.failTaskOnce) {
              harness.failTaskOnce = false;
              throw new Error('temporary task failure');
            }
            const existing = taskByKey.get(key);
            if (existing) return existing;
            harness.taskEffects.push(key);
            const value: Task = {
              id: `task-${taskByKey.size + 1}`,
              description: input.description,
              ...(input.role ? { role: input.role } : {}),
              prompt: input.prompt,
              contextQueries: input.contextQueries ?? [],
              memorySlugs: input.memorySlugs ?? [],
              claimed: false,
              revision: 1,
              createdAt: new Date(tick).toISOString(),
              updatedAt: new Date(tick).toISOString(),
            };
            taskByKey.set(key, value);
            return value;
          },
        },
        {
          async putIdempotent(slug, input, context) {
            const existing = memoryByKey.get(context.idempotencyKey);
            if (existing) return existing;
            harness.memoryEffects.push(context.idempotencyKey);
            const value: Memory = {
              slug,
              description: input.description,
              content: input.content,
              revision: 1,
              createdAt: new Date(tick).toISOString(),
              updatedAt: new Date(tick).toISOString(),
            };
            memoryByKey.set(context.idempotencyKey, value);
            return value;
          },
        },
        {
          async createItem(input, context) {
            const existing = entityByKey.get(context.idempotencyKey);
            if (existing) return existing;
            harness.entityEffects.push(context.idempotencyKey);
            const value = { entityId: `Q${entityByKey.size + 1}`, input };
            entityByKey.set(context.idempotencyKey, value);
            return value;
          },
        },
        {
          store: selectedStore,
          isEmpty,
          clock: () => new Date(++tick),
          createLeaseToken: () => `lease-${tick}`,
          leaseDurationMs: 2,
        },
      );
    },
  };
  return harness;
}

async function executeSql(db: D1DatabaseLike, sql: string): Promise<void> {
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/u)) {
    if (statement.trim()) await db.prepare(statement).run();
  }
}
