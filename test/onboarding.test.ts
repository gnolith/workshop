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
  it.each([
    ['entity', 'markApplying'],
    ['entity', 'beforeEffect'],
    ['entity', 'afterEffect'],
    ['entity', 'completeStep'],
    ['memory', 'markApplying'],
    ['memory', 'beforeEffect'],
    ['memory', 'afterEffect'],
    ['memory', 'completeStep'],
    ['task', 'markApplying'],
    ['task', 'beforeEffect'],
    ['task', 'afterEffect'],
    ['task', 'completeStep'],
  ] as const)(
    'safely reopens and retries a %s step interrupted at %s',
    async (kind, boundary) => {
      const harness = await createHarness();
      const plan = harness.service().plan({
        key: `fault-${kind}-${boundary}`,
        topics: ['One'],
        memories: [
          {
            slug: 'orientation',
            input: { description: 'Orientation', content: 'Known evidence.' },
          },
        ],
      });
      const isCheckpointFault =
        boundary === 'markApplying' || boundary === 'completeStep';
      let inject = true;
      const checkpointBoundary = isCheckpointFault ? boundary : 'markApplying';
      const faultingStore = isCheckpointFault
        ? checkpointFaultStore(
            harness.store,
            checkpointBoundary,
            kind,
            () => inject,
            () => {
              inject = false;
            },
          )
        : harness.store;
      if (!isCheckpointFault) {
        harness.sideEffectFault = { kind, phase: boundary };
      }

      const first = harness.service(faultingStore).apply(plan, 'owner');
      if (isCheckpointFault) {
        await expect(first).rejects.toThrow(`interrupted at ${boundary}`);
        harness.advance(10);
      } else {
        await expect(first).resolves.toMatchObject({
          state: 'retryable',
          retryable: true,
        });
      }

      const completed = await harness.service().resume(plan.key, 'owner');
      expect(completed).toMatchObject({
        state: 'completed',
        completedSteps: 3,
        totalSteps: 3,
      });
      expect(harness.entityEffects).toHaveLength(1);
      expect(harness.memoryEffects).toHaveLength(1);
      expect(harness.taskEffects).toHaveLength(1);
      expect(completed.steps.find((step) => step.kind === kind)?.attempts).toBe(
        boundary === 'markApplying' ? 1 : 2,
      );
    },
    15_000,
  );

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

  it('enforces the stored principal for resume, same-plan apply, and reapply', async () => {
    const harness = await createHarness();
    harness.failTaskOnce = true;
    const service = harness.service();
    const plan = service.plan({ key: 'principal-bound', topics: ['One'] });
    await service.apply(plan, 'owner');
    await expect(service.resume(plan.key, 'intruder')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.apply(plan, 'intruder')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(service.apply(plan, 'owner')).resolves.toMatchObject({
      state: 'completed',
    });
    await expect(service.apply(plan, 'intruder')).rejects.toMatchObject({
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
    sideEffectFault: undefined as
      | {
          kind: 'entity' | 'memory' | 'task';
          phase: 'beforeEffect' | 'afterEffect';
        }
      | undefined,
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
            maybeFailSideEffect(harness, 'task', 'beforeEffect');
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
            maybeFailSideEffect(harness, 'task', 'afterEffect');
            return value;
          },
        },
        {
          async putIdempotent(slug, input, context) {
            maybeFailSideEffect(harness, 'memory', 'beforeEffect');
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
            maybeFailSideEffect(harness, 'memory', 'afterEffect');
            return value;
          },
        },
        {
          async createItem(input, context) {
            maybeFailSideEffect(harness, 'entity', 'beforeEffect');
            const existing = entityByKey.get(context.idempotencyKey);
            if (existing) return existing;
            harness.entityEffects.push(context.idempotencyKey);
            const value = { entityId: `Q${entityByKey.size + 1}`, input };
            entityByKey.set(context.idempotencyKey, value);
            maybeFailSideEffect(harness, 'entity', 'afterEffect');
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

function maybeFailSideEffect(
  harness: {
    sideEffectFault:
      | {
          kind: 'entity' | 'memory' | 'task';
          phase: 'beforeEffect' | 'afterEffect';
        }
      | undefined;
  },
  kind: 'entity' | 'memory' | 'task',
  phase: 'beforeEffect' | 'afterEffect',
): void {
  if (
    harness.sideEffectFault?.kind === kind &&
    harness.sideEffectFault.phase === phase
  ) {
    harness.sideEffectFault = undefined;
    throw new Error(`interrupted at ${phase}`);
  }
}

function checkpointFaultStore(
  store: OnboardingCheckpointStore,
  boundary: 'markApplying' | 'completeStep',
  kind: 'entity' | 'memory' | 'task',
  shouldInject: () => boolean,
  didInject: () => void,
): OnboardingCheckpointStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'markApplying' && boundary === 'markApplying') {
        return async (
          ...args: Parameters<OnboardingCheckpointStore['markApplying']>
        ) => {
          const stepKey = args[1];
          if (shouldInject() && stepKey.includes(`:${kind}:`)) {
            didInject();
            throw new Error(`interrupted at ${boundary}`);
          }
          return target.markApplying(...args);
        };
      }
      if (property === 'completeStep' && boundary === 'completeStep') {
        return async (
          ...args: Parameters<OnboardingCheckpointStore['completeStep']>
        ) => {
          const stepKey = args[1];
          if (shouldInject() && stepKey.includes(`:${kind}:`)) {
            didInject();
            throw new Error(`interrupted at ${boundary}`);
          }
          return target.completeStep(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

async function executeSql(db: D1DatabaseLike, sql: string): Promise<void> {
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/u)) {
    if (statement.trim()) await db.prepare(statement).run();
  }
}
