import { afterEach, describe, expect, it } from 'vitest';
import { WORKSHOP_SCHEMA_VERSION } from '../src/migrations.js';
import { workshopPackage } from '../src/index.js';
import { HealthService } from '../src/server/health.js';
import { createTestContext, TEST_AUTHORIZATION } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

async function context() {
  const value = await createTestContext();
  disposals.push(value.dispose);
  return value;
}

describe('D1 integration and concurrency', () => {
  it('applies canonical migrations and reports schema health', async () => {
    expect(workshopPackage.schemaVersion).toBe(WORKSHOP_SCHEMA_VERSION);
    const { runtime } = await context();
    const health = await new HealthService({
      db: runtime.db,
      diamondHealth: runtime.diamondHealth,
      knowledge: runtime.knowledge,
      constructMcp: () => ({}),
    }).inspect();
    expect(health).toMatchObject({
      status: 'ok',
      workshopVersion: workshopPackage.version,
      schemaVersion: WORKSHOP_SCHEMA_VERSION,
      checks: { persistence: true, d1: true },
      missingTables: [],
      missingIndexes: [],
    });
  });

  it('reports an incompatible installed migration package version', async () => {
    const { runtime, db } = await context();
    await db
      .prepare(
        "UPDATE workshop_schema SET package_version = '1.0.0' WHERE singleton = 1",
      )
      .run();
    const health = new HealthService({
      db,
      diamondHealth: runtime.diamondHealth,
      knowledge: runtime.knowledge,
      constructMcp: () => ({}),
    });
    await expect(health.publicHealth()).resolves.toMatchObject({
      status: 'degraded',
      checks: { compatibility: false },
    });
  });

  it('creates memories and fully validated ephemeral packets without claiming', async () => {
    const { runtime, db } = await context();
    await runtime.memories.upsert(
      'source-method',
      {
        description: 'Source method',
        content: 'Check provenance.',
      },
      TEST_AUTHORIZATION,
    );
    const task = await runtime.tasks.create(
      {
        description: 'Research one entity',
        prompt: 'Establish supported facts.',
        role: 'researcher',
        memorySlugs: ['source-method'],
        contextQueries: [{ label: 'Current graph', sparql: 'ASK { }' }],
      },
      TEST_AUTHORIZATION,
    );
    const before = await runtime.tasks.get(task.id, TEST_AUTHORIZATION);
    const packet = await runtime.packets.get(task.id, TEST_AUTHORIZATION);
    const after = await runtime.tasks.get(task.id, TEST_AUTHORIZATION);
    expect(packet.memories).toHaveLength(1);
    expect(packet.context[0]?.error).toMatchObject({ code: 'forbidden' });
    expect(after).toEqual(before);
    await expect(
      runtime.tasks.create(
        {
          description: 'Invalid',
          prompt: 'Must not persist',
          memorySlugs: ['missing-memory'],
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM workshop_tasks')
      .first<{ count: number }>();
    expect(count?.count).toBe(1);

    await expect(
      runtime.tasks.create(
        {
          description: 'Unbounded packet',
          prompt: 'Must be rejected before linked-memory lookup',
          memorySlugs: Array.from(
            { length: 101 },
            (_, index) => `memory-${index}`,
          ),
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded', status: 413 });
  });

  it('allows exactly one concurrent claim', async () => {
    const { runtime } = await context();
    const task = await runtime.tasks.create(
      {
        description: 'Claim me',
        prompt: 'Work.',
      },
      TEST_AUTHORIZATION,
    );
    const outcomes = await Promise.allSettled([
      runtime.tasks.claim(task.id, TEST_AUTHORIZATION),
      runtime.tasks.claim(task.id, TEST_AUTHORIZATION),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(await runtime.tasks.get(task.id, TEST_AUTHORIZATION)).toMatchObject({
      claimed: true,
    });
  });

  it('preserves valid state across complete/update/archive races', async () => {
    const { runtime } = await context();
    const created = await runtime.tasks.create(
      {
        description: 'Race',
        prompt: 'Original',
      },
      TEST_AUTHORIZATION,
    );
    const claimed = await runtime.tasks.claim(created.id, TEST_AUTHORIZATION);
    const update = runtime.tasks.update(
      created.id,
      {
        expectedUpdatedAt: claimed.updatedAt,
        prompt: 'Updated without loss',
      },
      TEST_AUTHORIZATION,
    );
    const complete = runtime.tasks.complete(
      created.id,
      'Done',
      TEST_AUTHORIZATION,
    );
    const outcomes = await Promise.allSettled([update, complete]);
    const final = await runtime.tasks.get(created.id, TEST_AUTHORIZATION);
    expect(final).toMatchObject({
      claimed: false,
      completedAt: expect.any(String),
      result: 'Done',
    });
    if (outcomes[0]?.status === 'fulfilled')
      expect(final.prompt).toBe('Updated without loss');

    const second = await runtime.tasks.create(
      {
        description: 'Archive race',
        prompt: 'Work',
      },
      TEST_AUTHORIZATION,
    );
    await runtime.tasks.claim(second.id, TEST_AUTHORIZATION);
    const raceOutcomes = await Promise.allSettled([
      runtime.tasks.complete(second.id, 'Outcome', TEST_AUTHORIZATION),
      runtime.tasks.archive(
        second.id,
        {
          expectedUpdatedAt: (
            await runtime.tasks.get(second.id, TEST_AUTHORIZATION)
          ).updatedAt,
        },
        TEST_AUTHORIZATION,
      ),
    ]);
    expect(
      raceOutcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      raceOutcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const raced = await runtime.tasks.get(second.id, TEST_AUTHORIZATION);
    expect(raced.claimed).toBe(false);
    expect(raced.archivedAt || raced.completedAt).toBeTruthy();
  });

  it('enforces optimistic memory and task updates', async () => {
    const { runtime } = await context();
    const memory = await runtime.memories.upsert(
      'method',
      {
        description: 'Method',
        content: 'One',
      },
      TEST_AUTHORIZATION,
    );
    await runtime.memories.upsert(
      'method',
      {
        description: 'Method',
        content: 'Two',
        expectedUpdatedAt: memory.updatedAt,
      },
      TEST_AUTHORIZATION,
    );
    await expect(
      runtime.memories.upsert(
        'method',
        {
          description: 'Method',
          content: 'Stale',
          expectedUpdatedAt: memory.updatedAt,
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const task = await runtime.tasks.create(
      {
        description: 'Task',
        prompt: 'One',
      },
      TEST_AUTHORIZATION,
    );
    const changed = await runtime.tasks.update(
      task.id,
      {
        expectedUpdatedAt: task.updatedAt,
        prompt: 'Two',
      },
      TEST_AUTHORIZATION,
    );
    expect(changed.prompt).toBe('Two');
    await expect(
      runtime.tasks.update(
        task.id,
        {
          expectedUpdatedAt: task.updatedAt,
          prompt: 'Stale',
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows exact idempotent task retries but rejects key reuse', async () => {
    const { runtime } = await context();
    const input = {
      idempotencyKey: 'retry-key',
      description: 'Safe retry',
      prompt: 'Same operation',
    };
    const first = await runtime.tasks.create(input, TEST_AUTHORIZATION);
    await expect(
      runtime.tasks.create(input, TEST_AUTHORIZATION),
    ).resolves.toEqual(first);
    await expect(
      runtime.tasks.create(
        { ...input, prompt: 'Different operation' },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      runtime.tasks.create(
        {
          ...input,
          visibility: {
            version: 1,
            clauses: [[{ kind: 'principal', principalId: 'agent:test' }]],
          },
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('persists and compares memory idempotency keys, content, and visibility', async () => {
    const { runtime } = await context();
    const input = { description: 'Stable', content: 'Exact content' };
    const first = await runtime.memories.putIdempotent(
      'stable-memory',
      input,
      TEST_AUTHORIZATION,
      'memory-key',
    );
    await expect(
      runtime.memories.putIdempotent(
        'stable-memory',
        input,
        TEST_AUTHORIZATION,
        'memory-key',
      ),
    ).resolves.toEqual(first);
    await expect(
      runtime.memories.putIdempotent(
        'stable-memory',
        {
          ...input,
          visibility: {
            version: 1,
            clauses: [[{ kind: 'principal', principalId: 'agent:test' }]],
          },
        },
        TEST_AUTHORIZATION,
        'memory-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      runtime.memories.putIdempotent(
        'other-memory',
        input,
        TEST_AUTHORIZATION,
        'memory-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      runtime.memories.putIdempotent(
        'stable-memory',
        input,
        TEST_AUTHORIZATION,
        'other-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await runtime.memories.upsert(
      'stable-memory',
      { ...input, content: 'Human edit', expectedRevision: first.revision },
      TEST_AUTHORIZATION,
    );
    await expect(
      runtime.memories.putIdempotent(
        'stable-memory',
        input,
        TEST_AUTHORIZATION,
        'memory-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
