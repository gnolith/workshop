import { afterEach, describe, expect, it } from 'vitest';
import { createWorkshopCore } from '../src/server/context.js';
import type { TaskLeaseClaim } from '../src/server/tasks.js';
import { createTestContext, TEST_AUTHORIZATION } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

describe('task leases', () => {
  it('issues opaque owner-bound leases and idempotently releases them', async () => {
    const context = await createTestContext();
    disposals.push(context.dispose);
    const task = await context.runtime.tasks.create(
      {
        description: 'Lease this task',
        prompt: 'Verify owner-safe release.',
      },
      TEST_AUTHORIZATION,
    );
    const claim = await context.runtime.tasks.claimLease(
      task.id,
      60,
      TEST_AUTHORIZATION,
    );
    expect(claim.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(claim.leaseId).not.toBe(claim.leaseToken);
    expect(JSON.stringify(claim.task)).not.toContain(claim.leaseToken);
    await expect(
      context.runtime.tasks.updateWithLease(
        task.id,
        {
          description: 'Updated under lease',
          expectedRevision: claim.task.revision,
        },
        claim.leaseToken,
        TEST_AUTHORIZATION,
      ),
    ).resolves.toMatchObject({
      description: 'Updated under lease',
      claimed: true,
    });
    const afterUpdate = await context.runtime.tasks.get(
      task.id,
      TEST_AUTHORIZATION,
    );

    await expect(
      context.runtime.tasks.releaseLease(
        {
          taskId: task.id,
          leaseToken: 'A'.repeat(43),
          expectedRevision: claim.task.revision,
          idempotencyKey: 'release-wrong-token',
        },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const input = {
      taskId: task.id,
      leaseToken: claim.leaseToken,
      expectedRevision: afterUpdate.revision,
      idempotencyKey: 'release-once',
    };
    const receipt = await context.runtime.tasks.releaseLease(
      input,
      TEST_AUTHORIZATION,
    );
    expect(receipt).toMatchObject({
      taskId: task.id,
      released: true,
      replayed: false,
    });
    await expect(
      context.runtime.tasks.releaseLease(input, TEST_AUTHORIZATION),
    ).resolves.toEqual({ ...receipt, replayed: true });

    const completionTask = await context.runtime.tasks.create(
      {
        description: 'Complete with lease',
        prompt: 'Require the exact lease token.',
      },
      TEST_AUTHORIZATION,
    );
    const completionClaim = await context.runtime.tasks.claimLease(
      completionTask.id,
      60,
      TEST_AUTHORIZATION,
    );
    const completionInput = {
      taskId: completionTask.id,
      leaseToken: completionClaim.leaseToken,
      expectedRevision: completionClaim.task.revision,
      idempotencyKey: 'complete-once',
      result: 'done',
      outcomeKind: 'success',
    };
    const completed = await context.runtime.tasks.completeLease(
      completionInput,
      TEST_AUTHORIZATION,
    );
    expect(completed).toMatchObject({
      id: completionTask.id,
      result: 'done',
      claimed: false,
    });
    await expect(
      context.runtime.tasks.completeLease(completionInput, TEST_AUTHORIZATION),
    ).resolves.toEqual(completed);
    await expect(
      context.runtime.tasks.completeLease(
        { ...completionInput, result: 'different' },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(
      context.runtime.tasks.completeLease(
        { ...completionInput, outcomeKind: 'negative' },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(
      context.runtime.tasks.completeLease(
        { ...completionInput, leaseToken: 'A'.repeat(43) },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });

    const reconstructed = createWorkshopCore({
      persistence: context.db,
      authorization: context.authorization,
      knowledge: {
        authorizedReader: () => ({
          getEntity: async () => ({}),
          searchEntities: async () => ({ items: [], cursor: null }),
        }),
        health: async () => true,
      },
      diamondHealth: async () => true,
      cursorCodec: context.cursorCodec,
      search: context.search,
    });
    await expect(
      reconstructed.tasks.completeLease(completionInput, TEST_AUTHORIZATION),
    ).resolves.toEqual(completed);
    await expect(
      reconstructed.tasks.completeLease(
        { ...completionInput, result: 'restart-conflict' },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(
      reconstructed.tasks.completeLease(completionInput, {
        ...TEST_AUTHORIZATION,
        principalId: 'agent:other',
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/forbidden|conflict/u),
    });
  });

  it('returns one claim and one stable conflict for simultaneous claims', async () => {
    const context = await createTestContext();
    disposals.push(context.dispose);
    const task = await context.runtime.tasks.create(
      {
        description: 'Claim once',
        prompt: 'Race two claimers.',
      },
      TEST_AUTHORIZATION,
    );
    const results = await Promise.allSettled([
      context.runtime.tasks.claimLease(task.id, 60, TEST_AUTHORIZATION),
      context.runtime.tasks.claimLease(task.id, 60, TEST_AUTHORIZATION),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'conflict', status: 409 },
    });
    const winner = results.find(
      (result): result is PromiseFulfilledResult<TaskLeaseClaim> =>
        result.status === 'fulfilled',
    )!.value;
    const completion = {
      taskId: task.id,
      leaseToken: winner.leaseToken,
      expectedRevision: winner.task.revision,
      idempotencyKey: 'race-winner-completion',
      result: 'completed on the first attempt',
      outcomeKind: 'success',
    };
    const completed = await context.runtime.tasks.completeLease(
      completion,
      TEST_AUTHORIZATION,
    );
    expect(completed).toMatchObject({
      id: task.id,
      claimed: false,
      result: 'completed on the first attempt',
    });
    await expect(
      context.runtime.tasks.completeLease(completion, TEST_AUTHORIZATION),
    ).resolves.toEqual(completed);
    await expect(
      context.runtime.tasks.completeLease(
        { ...completion, result: 'altered replay' },
        TEST_AUTHORIZATION,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(
      context.runtime.tasks.completeLease(completion, {
        ...TEST_AUTHORIZATION,
        principalId: 'agent:loser',
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/forbidden|conflict/u),
    });
  });

  it('requires the live owner token to archive a leased task', async () => {
    const context = await createTestContext();
    disposals.push(context.dispose);
    const writer = {
      ...TEST_AUTHORIZATION,
      capabilities: TEST_AUTHORIZATION.capabilities.filter(
        (capability) => capability !== 'admin',
      ),
    };
    const task = await context.runtime.tasks.create(
      {
        description: 'Archive this task',
        prompt: 'Keep lease ownership fenced.',
      },
      writer,
    );
    const claim = await context.runtime.tasks.claimLease(task.id, 60, writer);
    await expect(
      context.runtime.tasks.archive(
        task.id,
        {
          expectedRevision: claim.task.revision,
          leaseToken: 'A'.repeat(43),
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const archived = await context.runtime.tasks.archive(
      task.id,
      {
        expectedRevision: claim.task.revision,
        leaseToken: claim.leaseToken,
      },
      writer,
    );
    expect(archived).toMatchObject({ id: task.id, claimed: false });
    expect(archived.archivedAt).toBeTruthy();
    await expect(
      context.db
        .prepare(
          `SELECT lease_id, lease_token_digest, lease_owner_principal_id,
                  lease_expires_at
           FROM workshop_tasks WHERE id = ?`,
        )
        .bind(task.id)
        .first(),
    ).resolves.toEqual({
      lease_id: null,
      lease_token_digest: null,
      lease_owner_principal_id: null,
      lease_expires_at: null,
    });
  });
});
