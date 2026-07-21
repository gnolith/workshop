import { afterEach, describe, expect, it } from 'vitest';
import { WORKSHOP_SCHEMA_VERSION } from '../src/migrations.js';
import { HealthService } from '../src/server/health.js';
import { createTestContext } from './helpers.js';

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
    const { runtime } = await context();
    const health = await new HealthService({
      db: runtime.db,
      sparql: runtime.sparql,
      knowledge: runtime.knowledge,
      constructMcp: () => ({}),
    }).inspect();
    expect(health).toMatchObject({
      status: 'ok',
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
      sparql: runtime.sparql,
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
    await runtime.memories.upsert('source-method', {
      description: 'Source method',
      content: 'Check provenance.',
    });
    const task = await runtime.tasks.create({
      description: 'Research one entity',
      prompt: 'Establish supported facts.',
      role: 'researcher',
      memorySlugs: ['source-method'],
      contextQueries: [{ label: 'Current graph', sparql: 'ASK { }' }],
    });
    const before = await runtime.tasks.get(task.id);
    const packet = await runtime.packets.get(task.id);
    const after = await runtime.tasks.get(task.id);
    expect(packet.memories).toHaveLength(1);
    expect(packet.context[0]?.result).toMatchObject({ data: true });
    expect(after).toEqual(before);
    await expect(
      runtime.tasks.create({
        description: 'Invalid',
        prompt: 'Must not persist',
        memorySlugs: ['missing-memory'],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM workshop_tasks')
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('allows exactly one concurrent claim', async () => {
    const { runtime } = await context();
    const task = await runtime.tasks.create({
      description: 'Claim me',
      prompt: 'Work.',
    });
    const outcomes = await Promise.allSettled([
      runtime.tasks.claim(task.id, 'agent:a'),
      runtime.tasks.claim(task.id, 'agent:b'),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(await runtime.tasks.get(task.id)).toMatchObject({ claimed: true });
  });

  it('preserves valid state across complete/update/archive races', async () => {
    const { runtime } = await context();
    const created = await runtime.tasks.create({
      description: 'Race',
      prompt: 'Original',
    });
    const claimed = await runtime.tasks.claim(created.id);
    const update = runtime.tasks.update(created.id, {
      expectedUpdatedAt: claimed.updatedAt,
      prompt: 'Updated without loss',
    });
    const complete = runtime.tasks.complete(created.id, 'Done');
    const outcomes = await Promise.allSettled([update, complete]);
    const final = await runtime.tasks.get(created.id);
    expect(final).toMatchObject({
      claimed: false,
      completedAt: expect.any(String),
      result: 'Done',
    });
    if (outcomes[0]?.status === 'fulfilled')
      expect(final.prompt).toBe('Updated without loss');

    const second = await runtime.tasks.create({
      description: 'Archive race',
      prompt: 'Work',
    });
    await runtime.tasks.claim(second.id);
    const raceOutcomes = await Promise.allSettled([
      runtime.tasks.complete(second.id, 'Outcome'),
      runtime.tasks.archive(second.id, {
        expectedUpdatedAt: (await runtime.tasks.get(second.id)).updatedAt,
        administrative: true,
        principalId: 'admin',
      }),
    ]);
    expect(
      raceOutcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      raceOutcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const raced = await runtime.tasks.get(second.id);
    expect(raced.claimed).toBe(false);
    expect(raced.archivedAt || raced.completedAt).toBeTruthy();
  });

  it('enforces optimistic memory and task updates', async () => {
    const { runtime } = await context();
    const memory = await runtime.memories.upsert('method', {
      description: 'Method',
      content: 'One',
    });
    await runtime.memories.upsert('method', {
      description: 'Method',
      content: 'Two',
      expectedUpdatedAt: memory.updatedAt,
    });
    await expect(
      runtime.memories.upsert('method', {
        description: 'Method',
        content: 'Stale',
        expectedUpdatedAt: memory.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const task = await runtime.tasks.create({
      description: 'Task',
      prompt: 'One',
    });
    const changed = await runtime.tasks.update(task.id, {
      expectedUpdatedAt: task.updatedAt,
      prompt: 'Two',
    });
    expect(changed.prompt).toBe('Two');
    await expect(
      runtime.tasks.update(task.id, {
        expectedUpdatedAt: task.updatedAt,
        prompt: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows exact idempotent task retries but rejects key reuse', async () => {
    const { runtime } = await context();
    const input = {
      idempotencyKey: 'retry-key',
      description: 'Safe retry',
      prompt: 'Same operation',
    };
    const first = await runtime.tasks.create(input);
    await expect(runtime.tasks.create(input)).resolves.toEqual(first);
    await expect(
      runtime.tasks.create({ ...input, prompt: 'Different operation' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
