import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '../src/protocol.js';
import { createWorkshopCore } from '../src/server/context.js';
import {
  backfillWorkshopAuthorizationBatch,
  inspectWorkshopAuthorizationReadiness,
} from '../src/server/authorization-readiness.js';
import {
  authorize,
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
  denied,
  requireSearchAdministration,
  type InstallationAuthorizationState,
  type WorkshopAuthorizationAuthority,
} from '../src/server/authorization.js';
import {
  createTestContext,
  createTestCursorCodec,
  TEST_AUTHORIZATION,
} from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

function context(
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return { ...TEST_AUTHORIZATION, ...overrides };
}

function mutableAuthorization(): WorkshopAuthorizationAuthority & {
  state: InstallationAuthorizationState | null;
  afterRead: ((count: number) => void | Promise<void>) | undefined;
  reads: number;
} {
  const source: WorkshopAuthorizationAuthority & {
    state: InstallationAuthorizationState | null;
    afterRead: ((count: number) => void | Promise<void>) | undefined;
    reads: number;
  } = {
    state: {
      installationId: TEST_AUTHORIZATION.installationId,
      authorizationRevision: TEST_AUTHORIZATION.authorizationRevision,
      searchGeneration: 1,
    },
    afterRead: undefined,
    reads: 0,
    async getInstallationAuthorizationState() {
      this.reads += 1;
      const snapshot = this.state ? { ...this.state } : null;
      await this.afterRead?.(this.reads);
      return snapshot;
    },
    async commitTaskMutation<T>(
      _db: import('../src/server/database.js').D1DatabaseLike,
      _context: AuthorizationContext,
      mutation: import('../src/server/database.js').D1PreparedStatementLike,
    ) {
      const current = await this.getInstallationAuthorizationState();
      if (
        !current ||
        current.authorizationRevision !== _context.authorizationRevision
      )
        throw denied();
      return mutation.first<T>();
    },
    async commitMemoryMutation<T>(
      _db: import('../src/server/database.js').D1DatabaseLike,
      _context: AuthorizationContext,
      mutation: import('../src/server/database.js').D1PreparedStatementLike,
    ) {
      return this.commitTaskMutation<T>(_db, _context, mutation);
    },
    async commitTaskBackfill(_db, _context, _state, mutations) {
      return _db.batch([...mutations]);
    },
    async commitMemoryBackfill(_db, _context, _state, mutations) {
      return _db.batch([...mutations]);
    },
    async commitCursorSnapshot(_db, _context, _state, mutations) {
      return _db.batch([...mutations]);
    },
  };
  return source;
}

async function setup() {
  const fixture = await createTestContext();
  disposals.push(fixture.dispose);
  const authorization = mutableAuthorization();
  const cursorCodec = createTestCursorCodec();
  const core = createWorkshopCore({
    persistence: fixture.db,
    authorization,
    knowledge: {
      authorizedReader: () => ({
        async getEntity() {
          return null;
        },
        async searchEntities() {
          return { items: [], cursor: null };
        },
      }),
      health: async () => true,
    },
    diamondHealth: async () => true,
    cursorCodec,
    search: fixture.search,
  });
  return { ...fixture, core, authorization, cursorCodec };
}

describe('Workshop authorization foundation', () => {
  it('matches Taproot context/CNF strictness including Unicode and dense arrays', () => {
    expect(
      normalizeAuthorizationContext(
        context({
          workspaceIds: ['workspace:z', 'workspace:test', 'workspace:z'],
        }),
      ).workspaceIds,
    ).toEqual(['workspace:test', 'workspace:z']);
    expect(() =>
      normalizeAuthorizationContext(
        context({ principalId: 'e\u0301', workspaceIds: [] }),
      ),
    ).toThrow('activeWorkspaceId must be present');
    expect(() =>
      normalizeAuthorizationContext(
        context({ principalId: ' bad', activeWorkspaceId: null }),
      ),
    ).toThrow('principalId is invalid');
    const sparse = Array<string>(2);
    sparse[1] = 'workspace:test';
    expect(() =>
      normalizeAuthorizationContext(
        context({ activeWorkspaceId: null, workspaceIds: sparse }),
      ),
    ).toThrow('workspaceIds must be dense');
    expect(() =>
      normalizeVisibilityScope({
        version: 1,
        clauses: [[]],
      }),
    ).toThrow('visibility clauses must contain');
  });

  it('keeps every capability exact and orthogonal', () => {
    const genericAdmin = context({ capabilities: ['admin'] });
    for (const capability of [
      'read',
      'task-write',
      'memory-write',
      'knowledge-write',
      'search:admin',
    ] as const) {
      expect(() => authorize(genericAdmin, capability)).toThrow(
        'Authorization denied',
      );
    }
    expect(() => authorize(genericAdmin, 'admin')).not.toThrow();
    expect(() => requireSearchAdministration(genericAdmin)).toThrow(
      'Authorization denied',
    );
    const searchAdmin = context({ capabilities: ['search:admin'] });
    expect(() => requireSearchAdministration(searchAdmin)).not.toThrow();
    expect(() => authorize(searchAdmin, 'read')).toThrow(
      'Authorization denied',
    );
  });

  it('prefilters by installation/workspace/principal/capability and revokes immediately', async () => {
    const { core } = await setup();
    const workspaceTask = await core.tasks.create(
      { description: 'Workspace secret', prompt: 'Do not leak' },
      context(),
    );
    await expect(
      core.tasks.get(workspaceTask.id, context({ principalId: 'agent:peer' })),
    ).resolves.toMatchObject({ id: workspaceTask.id });
    const outsider = context({
      principalId: 'agent:outsider',
      activeWorkspaceId: 'workspace:other',
      workspaceIds: ['workspace:other'],
    });
    await expect(
      core.tasks.get(workspaceTask.id, outsider),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Authorization denied',
    });
    await expect(
      core.tasks.search({ text: 'secret' }, outsider),
    ).resolves.toEqual({ items: [], cursor: null });
    await expect(
      core.tasks.get(
        workspaceTask.id,
        context({ installationId: 'installation:other' }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const privateMemory = await core.memories.upsert(
      'private',
      {
        description: 'Private',
        content: 'Owner only',
        visibility: {
          version: 1,
          clauses: [[{ kind: 'principal', principalId: 'agent:test' }]],
        },
      },
      context(),
    );
    await expect(
      core.memories.get(
        privateMemory.slug,
        context({ principalId: 'agent:peer' }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const capabilityMemory = await core.memories.upsert(
      'capability',
      {
        description: 'Capability',
        content: 'Requires a grant',
        visibility: {
          version: 1,
          clauses: [[{ kind: 'capability', capability: 'corpus:special' }]],
        },
      },
      context({
        capabilities: [...context().capabilities, 'corpus:special'] as never,
      }),
    );
    await expect(
      core.memories.get(capabilityMemory.slug, context()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      core.memories.get(
        capabilityMemory.slug,
        context({
          capabilities: [...context().capabilities, 'corpus:special'] as never,
        }),
      ),
    ).resolves.toMatchObject({ slug: 'capability' });

    await core.tasks.update(
      workspaceTask.id,
      {
        expectedRevision: workspaceTask.revision,
        visibility: {
          version: 1,
          clauses: [[{ kind: 'principal', principalId: 'agent:test' }]],
        },
      },
      context(),
    );
    await expect(
      core.tasks.get(workspaceTask.id, context({ principalId: 'agent:peer' })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('denies stale contexts even for empty lists and detects revocation during hydration', async () => {
    const { core, authorization } = await setup();
    await core.tasks.create(
      { description: 'Race', prompt: 'Recheck authorization' },
      context(),
    );
    authorization.state = {
      installationId: TEST_AUTHORIZATION.installationId,
      authorizationRevision: 2,
      searchGeneration: 1,
    };
    await expect(core.tasks.list({}, context())).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Authorization denied',
    });

    authorization.state.authorizationRevision = 1;
    authorization.reads = 0;
    authorization.afterRead = (count) => {
      if (count === 1 && authorization.state)
        authorization.state.authorizationRevision = 2;
    };
    await expect(core.tasks.list({}, context())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rechecks live authorization after memory existence prefiltering', async () => {
    const { core, authorization } = await setup();
    await core.memories.upsert(
      'race-memory',
      { description: 'Race', content: 'Do not leak existence' },
      context(),
    );
    authorization.reads = 0;
    authorization.afterRead = (count) => {
      if (count === 1 && authorization.state)
        authorization.state.authorizationRevision = 2;
    };
    await expect(
      core.memories.exists('race-memory', context()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('binds cursors to the complete grant context', async () => {
    const { core, cursorCodec, authorization } = await setup();
    await core.tasks.create({ description: 'One', prompt: 'One' }, context());
    await core.tasks.create({ description: 'Two', prompt: 'Two' }, context());
    const first = await core.tasks.list({ limit: 1 }, context());
    expect(first.cursor).toEqual(expect.any(String));
    expect(first.cursor).not.toContain(TEST_AUTHORIZATION.installationId);
    await expect(
      core.tasks.list({ limit: 1, cursor: `${first.cursor}x` }, context()),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Invalid pagination cursor',
      details: { field: 'cursor' },
    });
    await expect(
      core.tasks.list(
        { limit: 1, cursor: first.cursor!, text: 'different query' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      core.memories.list({ limit: 1, cursor: first.cursor! }, context()),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      core.tasks.list(
        { limit: 1, cursor: first.cursor! },
        context({ principalId: 'agent:peer' }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    authorization.state!.searchGeneration = 2;
    await expect(
      core.tasks.list({ limit: 1, cursor: first.cursor! }, context()),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Invalid pagination cursor',
    });
    authorization.state!.searchGeneration = 1;
    cursorCodec.generation = 'test-generation-2';
    await expect(
      core.tasks.list({ limit: 1, cursor: first.cursor! }, context()),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('replays durable snapshots and rechecks the metadata-only sentinel', async () => {
    const { core, db } = await setup();
    for (const description of ['One', 'Two', 'Three'])
      await core.tasks.create({ description, prompt: description }, context());
    const first = await core.tasks.list({ limit: 1 }, context());
    const replayOne = await core.tasks.list(
      { limit: 1, cursor: first.cursor! },
      context(),
    );
    const replayTwo = await core.tasks.list(
      { limit: 1, cursor: first.cursor! },
      context(),
    );
    expect(replayTwo.items).toEqual(replayOne.items);
    const sentinel = await db
      .prepare(
        `SELECT record_id FROM workshop_cursor_entries
         WHERE snapshot_id = (
           SELECT id FROM workshop_cursor_snapshots ORDER BY issued_at LIMIT 1
         ) AND ordinal = 2`,
      )
      .first<{ record_id: string }>();
    expect(sentinel).not.toBeNull();
    await db
      .prepare('UPDATE workshop_tasks SET revision = revision + 1 WHERE id = ?')
      .bind(sentinel!.record_id)
      .run();
    await expect(
      core.tasks.list({ limit: 1, cursor: first.cursor! }, context()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('supports the public 200-row page limit for Task and Memory snapshots', async () => {
    const { core, db } = await setup();
    const task = await core.tasks.create(
      { description: 'Bulk seed task', prompt: 'Seed' },
      context(),
    );
    await core.memories.upsert(
      'bulk-seed-memory',
      { description: 'Bulk seed memory', content: 'Seed' },
      context(),
    );
    await db
      .prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 200
         )
         INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            created_at, updated_at, revision, installation_id,
            owner_principal_id, workspace_id, visibility_scope,
            authorization_revision)
         SELECT printf('bulk-task-%03d', n), 'Bulk task', 'Bulk', '[]', '[]', 0,
                created_at, updated_at, revision, installation_id,
                owner_principal_id, workspace_id, visibility_scope,
                authorization_revision
         FROM sequence CROSS JOIN workshop_tasks WHERE id = ?`,
      )
      .bind(task.id)
      .run();
    await db
      .prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 200
         )
         INSERT INTO workshop_memories
           (slug, description, content, created_at, updated_at, revision,
            installation_id, owner_principal_id, workspace_id,
            visibility_scope, authorization_revision)
         SELECT printf('bulk-memory-%03d', n), 'Bulk memory', 'Bulk',
                created_at, updated_at, revision, installation_id,
                owner_principal_id, workspace_id, visibility_scope,
                authorization_revision
         FROM sequence CROSS JOIN workshop_memories
         WHERE slug = 'bulk-seed-memory'`,
      )
      .run();
    const taskPage = await core.tasks.list({ limit: 200 }, context());
    const memoryPage = await core.memories.list({ limit: 200 }, context());
    expect(taskPage.items).toHaveLength(200);
    expect(taskPage.cursor).toEqual(expect.any(String));
    expect(memoryPage.items).toHaveLength(200);
    expect(memoryPage.cursor).toEqual(expect.any(String));
  });

  it('never returns stale Task or Memory content changed before the final recheck', async () => {
    const { core, db, authorization } = await setup();
    const task = await core.tasks.create(
      { description: 'Stale task content', prompt: 'Must not return' },
      context(),
    );
    authorization.reads = 0;
    authorization.afterRead = async (count) => {
      if (count === 3)
        await db
          .prepare(
            `UPDATE workshop_tasks
             SET description = 'Changed task content', revision = revision + 1
             WHERE id = ?`,
          )
          .bind(task.id)
          .run();
    };
    await expect(core.tasks.list({}, context())).rejects.toMatchObject({
      code: 'forbidden',
    });

    authorization.afterRead = undefined;
    const memory = await core.memories.upsert(
      'stale-memory-content',
      { description: 'Stale memory', content: 'Must not return' },
      context(),
    );
    authorization.reads = 0;
    authorization.afterRead = async (count) => {
      if (count === 3)
        await db
          .prepare(
            `UPDATE workshop_memories
             SET content = 'Changed memory content', revision = revision + 1
             WHERE slug = ?`,
          )
          .bind(memory.slug)
          .run();
    };
    await expect(core.memories.list({}, context())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('leaves zero side effects when the atomic authority fence observes revocation', async () => {
    const { core, db, authorization } = await setup();
    authorization.reads = 0;
    authorization.afterRead = (count) => {
      if (count === 1 && authorization.state)
        authorization.state.authorizationRevision = 2;
    };
    await expect(
      core.tasks.create(
        { description: 'Must not commit', prompt: 'Revoked before fence' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      db.prepare('SELECT COUNT(*) AS count FROM workshop_tasks').first(),
    ).resolves.toMatchObject({ count: 0 });
  });

  it('leaves legacy metadata untouched when authorization changes at the backfill fence', async () => {
    const { db, authorization } = await setup();
    await db
      .prepare(
        `INSERT INTO workshop_tasks
         (id, description, prompt, context_queries, memory_slugs, claimed,
          created_at, updated_at, revision)
         VALUES ('legacy-race', 'Legacy race', 'Do not backfill', '[]', '[]', 0,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
      )
      .run();
    authorization.commitTaskBackfill = async () => {
      authorization.state!.authorizationRevision = 2;
      throw denied();
    };
    await expect(
      backfillWorkshopAuthorizationBatch(
        db,
        authorization,
        context({
          capabilities: [...context().capabilities, 'search:admin'],
        }),
        { domain: 'task' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      db
        .prepare(
          `SELECT installation_id, owner_principal_id, workspace_id,
                  visibility_scope, authorization_revision
           FROM workshop_tasks WHERE id = 'legacy-race'`,
        )
        .first(),
    ).resolves.toEqual({
      installation_id: null,
      owner_principal_id: null,
      workspace_id: null,
      visibility_scope: null,
      authorization_revision: null,
    });
  });

  it('requires exact task-write plus admin to reset an abandoned claim', async () => {
    const { core } = await setup();
    const created = await core.tasks.create(
      { description: 'Abandoned', prompt: 'Reset deliberately' },
      context(),
    );
    await core.tasks.claim(created.id, context());
    const cutoff = '9999-12-31T23:59:59.999Z';
    await expect(
      core.tasks.resetAbandonedClaim(
        created.id,
        cutoff,
        context({ capabilities: ['admin'] }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      core.tasks.resetAbandonedClaim(
        created.id,
        cutoff,
        context({ capabilities: ['task-write'] }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      core.tasks.resetAbandonedClaim(
        created.id,
        cutoff,
        context({ capabilities: ['task-write', 'admin'] }),
      ),
    ).resolves.toMatchObject({ id: created.id, claimed: false });
  });

  it('quarantines and explicitly repairs malformed or noncanonical all-nonnull policy', async () => {
    const { core, db, authorization } = await setup();
    for (const [id, visibility] of [
      ['invalid-cnf', '{"version":1,"clauses":[[]]}'],
      [
        'noncanonical-cnf',
        '{"clauses":[[{"workspaceId":"workspace:test","kind":"workspace"}]],"version":1}',
      ],
    ]) {
      await db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            created_at, updated_at, revision, installation_id,
            owner_principal_id, workspace_id, visibility_scope,
            authorization_revision)
           VALUES (?, 'POLICY SENTINEL', 'Do not hydrate', '[]', '[]', 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, ?, ?, ?, 1)`,
        )
        .bind(
          id,
          TEST_AUTHORIZATION.installationId,
          TEST_AUTHORIZATION.principalId,
          TEST_AUTHORIZATION.activeWorkspaceId,
          visibility,
        )
        .run();
    }
    await expect(inspectWorkshopAuthorizationReadiness(db)).resolves.toEqual({
      ready: false,
      quarantinedTasks: 2,
      quarantinedMemories: 0,
    });
    await expect(
      core.tasks.get('invalid-cnf', context()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const admin = context({
      capabilities: [...context().capabilities, 'search:admin'],
    });
    await backfillWorkshopAuthorizationBatch(db, authorization, admin, {
      domain: 'task',
    });
    await expect(inspectWorkshopAuthorizationReadiness(db)).resolves.toEqual({
      ready: true,
      quarantinedTasks: 0,
      quarantinedMemories: 0,
    });
  });

  it('quarantines null and partially populated legacy rows without loading them', async () => {
    const { core, db } = await setup();
    await db
      .prepare(
        `INSERT INTO workshop_tasks
         (id, description, prompt, context_queries, memory_slugs, claimed,
          created_at, updated_at, revision, installation_id, authorization_revision)
         VALUES ('partial', 'LEAK SENTINEL', 'LEAK SENTINEL', '[]', '[]', 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, 1)`,
      )
      .bind(TEST_AUTHORIZATION.installationId)
      .run();
    await db
      .prepare(
        `INSERT INTO workshop_memories
         (slug, description, content, created_at, updated_at, revision)
         VALUES ('legacy', 'LEAK SENTINEL', 'LEAK SENTINEL', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP, 1)`,
      )
      .run();
    await expect(
      core.tasks.list({ text: 'LEAK SENTINEL' }, context()),
    ).resolves.toEqual({ items: [], cursor: null });
    await expect(
      core.memories.list({ text: 'LEAK SENTINEL' }, context()),
    ).resolves.toEqual({ items: [], cursor: null });
    await expect(core.tasks.get('partial', context())).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Authorization denied',
    });
  });

  it('requires explicit search administration for bounded resumable legacy backfill', async () => {
    const { core, db, authorization } = await setup();
    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      await db
        .prepare(
          `INSERT INTO workshop_tasks
           (id, description, prompt, context_queries, memory_slugs, claimed,
            created_at, updated_at, revision)
           VALUES (?, 'Legacy task', 'Migrate deliberately', '[]', '[]', 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
        )
        .bind(id)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO workshop_memories
         (slug, description, content, created_at, updated_at, revision)
         VALUES ('legacy-memory', 'Legacy memory', 'Migrate deliberately',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
      )
      .run();
    await expect(inspectWorkshopAuthorizationReadiness(db)).resolves.toEqual({
      ready: false,
      quarantinedTasks: 3,
      quarantinedMemories: 1,
    });
    await expect(
      backfillWorkshopAuthorizationBatch(
        db,
        authorization,
        context({ capabilities: ['admin'] }),
        { domain: 'task' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const admin = context({
      capabilities: [...context().capabilities, 'search:admin'],
    });
    const first = await backfillWorkshopAuthorizationBatch(
      db,
      authorization,
      admin,
      { domain: 'task', limit: 2 },
    );
    expect(first).toEqual({
      domain: 'task',
      updated: 2,
      cursor: '2',
      done: false,
    });
    await expect(
      backfillWorkshopAuthorizationBatch(db, authorization, admin, {
        domain: 'task',
        after: first.cursor!,
        limit: 2,
      }),
    ).resolves.toEqual({
      domain: 'task',
      updated: 1,
      cursor: null,
      done: true,
    });
    await backfillWorkshopAuthorizationBatch(db, authorization, admin, {
      domain: 'memory',
    });
    await expect(inspectWorkshopAuthorizationReadiness(db)).resolves.toEqual({
      ready: true,
      quarantinedTasks: 0,
      quarantinedMemories: 0,
    });
    await expect(core.tasks.get('legacy-a', context())).resolves.toMatchObject({
      ownerPrincipalId: TEST_AUTHORIZATION.principalId,
      workspaceId: TEST_AUTHORIZATION.activeWorkspaceId,
    });
    await expect(
      core.memories.get('legacy-memory', context()),
    ).resolves.toMatchObject({ slug: 'legacy-memory' });
  });
});
