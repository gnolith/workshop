import { afterEach, describe, expect, it } from 'vitest';
import { createWorkshopCore } from '../src/server/context.js';
import { createTestContext, TEST_AUTHORIZATION } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

describe('Workshop durable operation idempotency', () => {
  it('replays prompt create/update/delete across reconstructed services', async () => {
    const fixture = await createTestContext();
    disposals.push(fixture.dispose);
    const created = await fixture.runtime.prompts?.create(
      { name: 'idempotent-prompt', promptText: 'First' },
      TEST_AUTHORIZATION,
      'prompt-create-key',
    );
    const replay = await fixture.runtime.prompts?.create(
      { promptText: 'First', name: 'idempotent-prompt' },
      TEST_AUTHORIZATION,
      'prompt-create-key',
    );
    expect(replay).toEqual(created);
    await expect(
      fixture.runtime.prompts?.create(
        { name: 'idempotent-prompt-other', promptText: 'Different' },
        TEST_AUTHORIZATION,
        'prompt-create-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const reconstructed = createWorkshopCore({
      persistence: fixture.db,
      authorization: fixture.authorization,
      knowledge: {
        authorizedReader: () => ({
          getEntity: async () => ({}),
          searchEntities: async () => ({ items: [], cursor: null }),
        }),
        health: async () => true,
      },
      diamondHealth: async () => true,
      cursorCodec: fixture.cursorCodec,
      search: fixture.search,
    });
    const updated = await reconstructed.prompts?.update(
      String(created?.id),
      { expectedRevision: 1, promptText: 'Second' },
      TEST_AUTHORIZATION,
      'prompt-update-key',
    );
    await expect(
      reconstructed.prompts?.update(
        String(created?.id),
        { expectedRevision: 1, promptText: 'Second' },
        TEST_AUTHORIZATION,
        'prompt-update-key',
      ),
    ).resolves.toEqual(updated);
    await reconstructed.prompts?.delete(
      String(created?.id),
      2,
      TEST_AUTHORIZATION,
      'prompt-delete-key',
    );
    await expect(
      reconstructed.prompts?.delete(
        String(created?.id),
        2,
        TEST_AUTHORIZATION,
        'prompt-delete-key',
      ),
    ).resolves.toBeUndefined();
  });

  it('serializes concurrent prompt creation and replays one receipt', async () => {
    const fixture = await createTestContext();
    disposals.push(fixture.dispose);
    const create = () =>
      fixture.runtime.prompts?.create(
        { name: 'concurrent-prompt', promptText: 'Same' },
        TEST_AUTHORIZATION,
        'concurrent-key',
      );
    const [first, second] = await Promise.all([create(), create()]);
    expect(second).toEqual(first);
    await expect(
      fixture.db
        .prepare(
          `SELECT COUNT(*) AS count FROM workshop_operation_receipts
           WHERE operation = 'prompt.create' AND idempotency_key = ?`,
        )
        .bind('concurrent-key')
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it('replays memory deletion without disclosing across principals', async () => {
    const fixture = await createTestContext();
    disposals.push(fixture.dispose);
    const memory = await fixture.runtime.memories.putIdempotent(
      'idempotent-memory',
      { description: 'Memory', content: 'Content' },
      TEST_AUTHORIZATION,
      'memory-create-key',
    );
    await fixture.runtime.memories.delete(
      memory.slug,
      memory.revision,
      TEST_AUTHORIZATION,
      'memory-delete-key',
    );
    await expect(
      fixture.runtime.memories.delete(
        memory.slug,
        memory.revision,
        TEST_AUTHORIZATION,
        'memory-delete-key',
      ),
    ).resolves.toBeUndefined();
    await expect(
      fixture.runtime.memories.delete(
        memory.slug,
        memory.revision,
        { ...TEST_AUTHORIZATION, principalId: 'agent:other' },
        'memory-delete-key',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('distinguishes memory create replay from new-key optimistic updates after restart', async () => {
    const fixture = await createTestContext();
    disposals.push(fixture.dispose);
    const created = await fixture.runtime.memories.putIdempotent(
      'restart-memory',
      { description: 'Stable description', content: 'First content' },
      TEST_AUTHORIZATION,
      'memory-create-key',
    );
    const reconstructed = createWorkshopCore({
      persistence: fixture.db,
      authorization: fixture.authorization,
      knowledge: {
        authorizedReader: () => ({
          getEntity: async () => ({}),
          searchEntities: async () => ({ items: [], cursor: null }),
        }),
        health: async () => true,
      },
      diamondHealth: async () => true,
      cursorCodec: fixture.cursorCodec,
      search: fixture.search,
    });
    await expect(
      reconstructed.memories.putIdempotent(
        created.slug,
        { description: 'Stable description', content: 'First content' },
        TEST_AUTHORIZATION,
        'memory-create-key',
      ),
    ).resolves.toEqual(created);
    await expect(
      reconstructed.memories.putIdempotent(
        created.slug,
        { description: 'Stable description', content: 'Altered create' },
        TEST_AUTHORIZATION,
        'memory-create-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const updateInput = {
      description: 'Stable description',
      content: 'Second content',
      expectedRevision: 1,
    };
    const updated = await reconstructed.memories.putIdempotent(
      created.slug,
      updateInput,
      TEST_AUTHORIZATION,
      'memory-update-key',
    );
    expect(updated).toMatchObject({ revision: 2, content: 'Second content' });
    await expect(
      reconstructed.memories.putIdempotent(
        created.slug,
        updateInput,
        TEST_AUTHORIZATION,
        'memory-update-key',
      ),
    ).resolves.toEqual(updated);
    await expect(
      reconstructed.memories.putIdempotent(
        created.slug,
        { ...updateInput, content: 'Conflicting second content' },
        TEST_AUTHORIZATION,
        'memory-update-key',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const concurrentInput = {
      description: 'Stable description',
      content: 'Third content',
      expectedRevision: 2,
    };
    const [first, second] = await Promise.all([
      reconstructed.memories.putIdempotent(
        created.slug,
        concurrentInput,
        TEST_AUTHORIZATION,
        'memory-concurrent-key',
      ),
      reconstructed.memories.putIdempotent(
        created.slug,
        concurrentInput,
        TEST_AUTHORIZATION,
        'memory-concurrent-key',
      ),
    ]);
    expect(second).toEqual(first);
    expect(first.revision).toBe(3);
    await expect(
      reconstructed.memories.history(created.slug, TEST_AUTHORIZATION),
    ).resolves.toHaveLength(3);
  });
});
