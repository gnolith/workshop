import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  InvalidAuthorizationError,
  KNOWLEDGE_WRITE_CAPABILITY,
  bootstrapTaprootAuthorization,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  createInstallationAuthorizationGuard,
  createInstallationDomainMutationGuard,
  createItem,
  createTaprootHostWriteCapability,
  initializeTaproot,
} from '@gnolith/taproot';
import { createWorkshopCore } from '@gnolith/workshop/core';
import { applyWorkshopMigrations } from '@gnolith/workshop/migrations';
import { WorkshopError } from '@gnolith/workshop/protocol';

const path = join(tmpdir(), `workshop-taproot-${randomUUID()}.sqlite`);
const db = new NodeSqliteDatabase(path);
const options = { baseIri: 'https://conformance.gnolith.test' };
const installationId = 'conformance:installation';
const workspaceId = 'conformance:workspace';

try {
  await initializeTaproot(db, options);
  await applyWorkshopMigrations(db);
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const capability = createTaprootHostWriteCapability(db, options, key);
  const cursorKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const taprootCursorCodec = createAuthorizationCursorCodec(cursorKey);
  await bootstrapTaprootAuthorization(db, options, capability, installationId);
  const knowledgeGuard = await createInstallationAuthorizationGuard(
    db,
    options,
    capability,
  );
  const taskGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    { domain: 'workshop.task', capability: 'task-write' },
  );
  const memoryGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    { domain: 'workshop.memory', capability: 'memory-write' },
  );
  const taskBackfillGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    {
      domain: 'workshop.task.authorization-backfill',
      capability: 'search:admin',
    },
  );
  const memoryBackfillGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    {
      domain: 'workshop.memory.authorization-backfill',
      capability: 'search:admin',
    },
  );
  const cursorSnapshotGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    { domain: 'workshop.cursor.snapshot', capability: 'read' },
  );
  const taskContext = context('task-agent', ['read', 'task-write']);
  const memoryContext = context('memory-agent', ['read', 'memory-write']);
  const authority = {
    getInstallationAuthorizationState: () => taskGuard.readCurrentState(),
    commitTaskMutation: (mutationDb, actor, statement) =>
      firstDomainRow(db, mutationDb, taskGuard, actor, statement),
    commitMemoryMutation: (mutationDb, actor, statement) =>
      firstDomainRow(db, mutationDb, memoryGuard, actor, statement),
    commitTaskBackfill: (mutationDb, actor, state, statements) =>
      domainBatch(db, mutationDb, taskBackfillGuard, actor, state, statements),
    commitMemoryBackfill: (mutationDb, actor, state, statements) =>
      domainBatch(
        db,
        mutationDb,
        memoryBackfillGuard,
        actor,
        state,
        statements,
      ),
    commitCursorSnapshot: (mutationDb, actor, state, statements) =>
      domainBatch(
        db,
        mutationDb,
        cursorSnapshotGuard,
        actor,
        state,
        statements,
      ),
  };
  const core = workshop(authority);

  const task = await core.tasks.create(
    { description: 'Task-only guarded write', prompt: 'Write exactly once.' },
    taskContext,
  );
  const memory = await core.memories.upsert(
    'memory-only-guarded-write',
    {
      description: 'Memory-only guarded write',
      content: 'Persist exactly once.',
    },
    memoryContext,
  );
  assert.equal(task.authorizationRevision, 1);
  assert.equal(memory.authorizationRevision, 1);

  for (const operation of [
    () =>
      core.memories.upsert(
        'task-on-memory',
        { description: 'Denied', content: 'Denied' },
        taskContext,
      ),
    () =>
      core.tasks.create(
        { description: 'Memory on Task', prompt: 'Denied' },
        memoryContext,
      ),
    () =>
      core.tasks.create(
        { description: 'Knowledge on Task', prompt: 'Denied' },
        context('knowledge-agent', ['read', KNOWLEDGE_WRITE_CAPABILITY]),
      ),
    () =>
      core.memories.upsert(
        'knowledge-on-memory',
        { description: 'Denied', content: 'Denied' },
        context('knowledge-agent', ['read', KNOWLEDGE_WRITE_CAPABILITY]),
      ),
    () =>
      core.tasks.create(
        { description: 'Cross installation', prompt: 'Denied' },
        { ...taskContext, installationId: 'other-installation' },
      ),
    () =>
      core.memories.upsert(
        'stale-memory',
        { description: 'Denied', content: 'Denied' },
        { ...memoryContext, authorizationRevision: 0 },
      ),
  ]) {
    await assert.rejects(operation, {
      name: 'WorkshopError',
      code: 'forbidden',
      status: 403,
    });
  }

  const failingAuthority = {
    ...authority,
    async commitTaskMutation(_db, actor, statement) {
      await taskGuard.batchWithExpectedRevision(actor, [
        statement,
        db.prepare('INSERT INTO taproot_assertions(assertion_key) SELECT NULL'),
      ]);
      throw new Error('unreachable');
    },
  };
  await assert.rejects(
    workshop(failingAuthority).tasks.create(
      { description: 'Must roll back', prompt: 'No side effect.' },
      taskContext,
    ),
  );

  const workshopProof = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM workshop_tasks) AS tasks,
         (SELECT COUNT(*) FROM workshop_memories) AS memories,
         authorization_revision, search_generation
       FROM taproot_installation_authorization WHERE singleton = 1`,
    )
    .first();
  assert.deepEqual(
    { ...workshopProof },
    {
      tasks: 1,
      memories: 1,
      authorization_revision: 1,
      search_generation: 1,
    },
  );

  const knowledgeContext = context('knowledge-agent', [
    KNOWLEDGE_WRITE_CAPABILITY,
  ]);
  assert.throws(
    () =>
      createItem(db, options, knowledgeGuard, knowledgeContext, { id: 'Q1' }),
    InvalidAuthorizationError,
  );
  const afterDeniedKnowledge = await canonicalProof();
  assert.deepEqual(afterDeniedKnowledge, {
    entities: 0,
    revisions: 0,
    audits: 0,
    policies: 0,
    outbox: 0,
    authorization_revision: 1,
    search_generation: 1,
  });

  const receipt = await createItem(
    db,
    options,
    knowledgeGuard,
    knowledgeContext,
    {
      id: 'Q1',
      labels: { en: { language: 'en', value: 'Guarded write' } },
      authorization: {
        installationId,
        workspaceId,
        ownerPrincipalId: 'knowledge-agent',
        visibility: { version: 1, clauses: [] },
        statementRestrictions: {},
        expectedAuthorizationRevision: 1,
      },
    },
  );
  assert.deepEqual(receipt, {
    entityId: 'Q1',
    previousRevision: null,
    newRevision: 1,
    status: 'committed',
    authorizationRevision: 2,
    searchGeneration: 2,
  });
  assert.deepEqual(await canonicalProof(), {
    entities: 1,
    revisions: 1,
    audits: 1,
    policies: 1,
    outbox: 1,
    authorization_revision: 2,
    search_generation: 2,
  });
  const freshKnowledgeContext = context(
    'knowledge-agent',
    ['read', KNOWLEDGE_WRITE_CAPABILITY],
    2,
  );
  const liveReader = createAuthorizedTaproot(
    db,
    options,
    freshKnowledgeContext,
    { cursorCodec: taprootCursorCodec },
  );
  assert.equal((await liveReader.getEntity('Q1')).entity.id, 'Q1');
  assert.equal(
    (await liveReader.searchEntities('Guarded', { limit: 10 })).items[0]
      ?.entityId,
    'Q1',
  );
  assert.equal(
    (
      await core.knowledge.call(
        { name: 'get_entity', input: { entityId: 'Q1' } },
        freshKnowledgeContext,
      )
    ).entity.id,
    'Q1',
  );
  await createItem(db, options, knowledgeGuard, freshKnowledgeContext, {
    id: 'Q2',
    authorization: {
      installationId,
      workspaceId,
      ownerPrincipalId: 'knowledge-agent',
      visibility: {
        version: 1,
        clauses: [[{ kind: 'principal', principalId: 'knowledge-agent' }]],
      },
      statementRestrictions: {},
      expectedAuthorizationRevision: 2,
    },
  });
  await assert.rejects(liveReader.getEntity('Q1'), {
    name: 'AuthorizationDeniedError',
  });
  await assert.rejects(
    workshop(authority).knowledge.call(
      { name: 'get_entity', input: { entityId: 'Q2' } },
      context('denied-agent', ['read'], 3),
    ),
    { name: 'AuthorizationDeniedError' },
  );
  const staleKnowledgeContext = context(
    'knowledge-agent',
    ['read', KNOWLEDGE_WRITE_CAPABILITY],
    3,
  );
  const revokingCore = workshop(authority, (actor) => {
    const real = createAuthorizedTaproot(db, options, actor, {
      cursorCodec: taprootCursorCodec,
    });
    return {
      async getEntity(id) {
        await createItem(db, options, knowledgeGuard, staleKnowledgeContext, {
          id: 'Q3',
          authorization: {
            installationId,
            workspaceId,
            ownerPrincipalId: 'knowledge-agent',
            visibility: { version: 1, clauses: [] },
            statementRestrictions: {},
            expectedAuthorizationRevision: 3,
          },
        });
        return real.getEntity(id);
      },
      searchEntities: (...args) => real.searchEntities(...args),
    };
  });
  await assert.rejects(
    revokingCore.knowledge.call(
      { name: 'get_entity', input: { entityId: 'Q1' } },
      staleKnowledgeContext,
    ),
    { name: 'AuthorizationDeniedError' },
  );

  const revisionFourTask = context('task-agent', ['read', 'task-write'], 4);
  const lateRevocationAuthority = {
    ...authority,
    async commitTaskMutation(mutationDb, actor, statement) {
      await createItem(
        db,
        options,
        knowledgeGuard,
        context('knowledge-agent', [KNOWLEDGE_WRITE_CAPABILITY], 4),
        {
          id: 'Q4',
          authorization: {
            installationId,
            workspaceId,
            ownerPrincipalId: 'knowledge-agent',
            visibility: { version: 1, clauses: [] },
            statementRestrictions: {},
            expectedAuthorizationRevision: 4,
          },
        },
      );
      return firstDomainRow(db, mutationDb, taskGuard, actor, statement);
    },
  };
  await assert.rejects(
    workshop(lateRevocationAuthority).tasks.create(
      { description: 'Late revoked task', prompt: 'Must roll back.' },
      revisionFourTask,
    ),
    { name: 'WorkshopError', code: 'forbidden', status: 403 },
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM workshop_tasks WHERE description = 'Late revoked task'",
        )
        .first()
    ).count,
    0,
  );

  function context(principalId, capabilities, authorizationRevision = 1) {
    return {
      installationId,
      principalId,
      activeWorkspaceId: workspaceId,
      workspaceIds: [workspaceId],
      capabilities,
      authorizationRevision,
    };
  }

  function workshop(authorization, readerFactory) {
    return createWorkshopCore({
      persistence: db,
      authorization,
      knowledge: {
        authorizedReader: (actor) =>
          readerFactory?.(actor) ??
          createAuthorizedTaproot(db, options, actor, {
            cursorCodec: taprootCursorCodec,
          }),
        health: async () => true,
      },
      diamondHealth: async () => true,
      cursorCodec: {
        currentGeneration: async () => 'conformance-generation',
        digest: async (purpose, value) => {
          const signature = await crypto.subtle.sign(
            'HMAC',
            key,
            new Uint8Array([...new TextEncoder().encode(purpose), 0, ...value]),
          );
          return Array.from(new Uint8Array(signature), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
        },
        seal: async () => {
          throw new Error('pagination not exercised');
        },
        open: async () => {
          throw new Error('pagination not exercised');
        },
      },
    });
  }

  async function canonicalProof() {
    const row = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM taproot_entities) AS entities,
           (SELECT COUNT(*) FROM taproot_entity_revisions) AS revisions,
           (SELECT COUNT(*) FROM taproot_audit_events) AS audits,
           (SELECT COUNT(*) FROM taproot_entity_authorization) AS policies,
           (SELECT COUNT(*) FROM taproot_authorization_projection_outbox) AS outbox,
           authorization_revision, search_generation
         FROM taproot_installation_authorization WHERE singleton = 1`,
      )
      .first();
    return { ...row };
  }
} finally {
  await db.close();
  await rm(path, { force: true });
}

async function firstDomainRow(
  expectedDb,
  mutationDb,
  guard,
  context,
  statement,
) {
  if (mutationDb !== expectedDb)
    throw new WorkshopError(
      'internal_error',
      'Workshop database mismatch',
      500,
    );
  try {
    const result = await guard.batchWithExpectedRevision(context, [statement]);
    return result.results[0]?.results?.[0] ?? null;
  } catch (error) {
    if (error instanceof InvalidAuthorizationError)
      throw new WorkshopError('forbidden', 'Authorization denied', 403);
    throw error;
  }
}

async function domainBatch(
  expectedDb,
  mutationDb,
  guard,
  context,
  expectedState,
  statements,
) {
  if (mutationDb !== expectedDb)
    throw new WorkshopError(
      'internal_error',
      'Workshop database mismatch',
      500,
    );
  try {
    const live = await guard.readCurrentState();
    if (
      live.installationId !== expectedState.installationId ||
      live.authorizationRevision !== expectedState.authorizationRevision ||
      live.searchGeneration !== expectedState.searchGeneration
    )
      throw new InvalidAuthorizationError('Authorization denied');
    const result = await guard.batchWithExpectedRevision(context, statements);
    return result.results;
  } catch (error) {
    if (error instanceof InvalidAuthorizationError)
      throw new WorkshopError('forbidden', 'Authorization denied', 403);
    throw error;
  }
}

console.log('packed Taproot and Workshop domain guard conformance passed');
