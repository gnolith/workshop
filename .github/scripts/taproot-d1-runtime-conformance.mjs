import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import {
  InvalidAuthorizationError,
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
import {
  backfillWorkshopAuthorizationBatch,
  createWorkshopSearchIntegrationV1,
  inspectWorkshopAuthorizationReadiness,
} from '@gnolith/workshop/server';

const persist = await mkdtemp(join(tmpdir(), 'workshop-d1-conformance-'));
const options = { baseIri: 'https://d1-conformance.gnolith.test' };
const installationId = 'd1:installation';
const workspaceId = 'd1:workspace';
const actor = context(1);
let miniflare;

try {
  miniflare = createMiniflare();
  let db = await miniflare.getD1Database('DB');
  await initializeTaproot(db, options);
  await applyWorkshopMigrations(db);
  let capability = await createHostCapability(db);
  await bootstrapTaprootAuthorization(db, options, capability, installationId);
  let assembly = await assemble(db, capability);
  await db.batch([
    db.prepare(
      `INSERT INTO workshop_tasks
       (id, title, description, prompt, context_queries, memory_slugs, claimed,
        created_at, updated_at, revision)
       VALUES ('legacy-d1-a', 'Legacy D1 A', 'Legacy D1 A', 'Backfill before restart', '[]',
               '[]', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
    ),
    db.prepare(
      `INSERT INTO workshop_tasks
       (id, title, description, prompt, context_queries, memory_slugs, claimed,
        created_at, updated_at, revision)
       VALUES ('legacy-d1-b', 'Legacy D1 B', 'Legacy D1 B', 'Backfill after restart', '[]',
               '[]', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
    ),
  ]);
  const backfillFirst = await backfillWorkshopAuthorizationBatch(
    db,
    assembly.authority,
    actor,
    { domain: 'task', limit: 1 },
  );
  assert.equal(backfillFirst.updated, 1);
  assert.equal(typeof backfillFirst.cursor, 'string');
  let core = workshop(db, assembly);
  await core.tasks.create(
    { description: 'Paged record first', prompt: 'Persist this snapshot.' },
    actor,
  );
  await core.tasks.create(
    { description: 'Paged record second', prompt: 'Resume after restart.' },
    actor,
  );
  const first = await core.tasks.list(
    { limit: 1, text: 'Paged record' },
    actor,
  );
  assert.equal(first.items.length, 1);
  assert.equal(typeof first.cursor, 'string');

  await miniflare.dispose();
  miniflare = createMiniflare();
  db = await miniflare.getD1Database('DB');
  capability = await createHostCapability(db);
  assembly = await assemble(db, capability);
  const backfillSecond = await backfillWorkshopAuthorizationBatch(
    db,
    assembly.authority,
    actor,
    { domain: 'task', after: backfillFirst.cursor, limit: 100 },
  );
  assert.equal(backfillSecond.updated, 1);
  assert.equal(backfillSecond.done, true);
  assert.deepEqual(await inspectWorkshopAuthorizationReadiness(db), {
    ready: true,
    quarantinedTasks: 0,
    quarantinedMemories: 0,
  });
  core = workshop(db, assembly);
  const second = await core.tasks.list(
    { limit: 1, text: 'Paged record', cursor: first.cursor },
    actor,
  );
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, first.items[0].id);
  assert.equal(second.cursor, null);
  for (const domain of [
    assembly.search.task,
    assembly.search.memory,
    assembly.search.prompt,
  ]) {
    let complete = false;
    while (!complete)
      ({ complete } = await domain.producer.adoptLegacyPage(actor, {
        limit: 100,
      }));
  }

  const knowledgeGuard = await createInstallationAuthorizationGuard(
    db,
    options,
    assembly.capability,
  );
  const receipt = await createItem(db, options, knowledgeGuard, actor, {
    id: 'Q1',
    labels: { en: { language: 'en', value: 'D1 guarded entity' } },
    authorization: {
      installationId,
      workspaceId,
      ownerPrincipalId: actor.principalId,
      visibility: { version: 1, clauses: [] },
      statementRestrictions: {},
      expectedAuthorizationRevision: 1,
    },
  });
  assert.equal(receipt.authorizationRevision, 2);
  const current = context(2);
  const reader = createAuthorizedTaproot(db, options, current, {
    cursorCodec: assembly.taprootCursorCodec,
  });
  assert.equal((await reader.getEntity('Q1')).entity.id, 'Q1');
  assert.equal(
    (await reader.searchEntities('guarded', { limit: 10 })).items[0]?.entityId,
    'Q1',
  );
  core = workshop(db, assembly);
  assert.equal(
    (
      await core.knowledge.call(
        { name: 'get_entity', input: { entityId: 'Q1' } },
        current,
      )
    ).entity.id,
    'Q1',
  );
  await createItem(db, options, knowledgeGuard, current, {
    id: 'Q2',
    authorization: {
      installationId,
      workspaceId,
      ownerPrincipalId: actor.principalId,
      visibility: {
        version: 1,
        clauses: [[{ kind: 'principal', principalId: actor.principalId }]],
      },
      statementRestrictions: {},
      expectedAuthorizationRevision: 2,
    },
  });
  await assert.rejects(
    core.knowledge.call(
      { name: 'get_entity', input: { entityId: 'Q2' } },
      { ...context(3), principalId: 'd1-denied-agent' },
    ),
    { name: 'AuthorizationDeniedError' },
  );
  const stale = context(3);
  const revokingCore = workshop(db, assembly, (readerContext) => {
    const real = createAuthorizedTaproot(db, options, readerContext, {
      cursorCodec: assembly.taprootCursorCodec,
    });
    return {
      async getEntity(id) {
        await createItem(db, options, knowledgeGuard, stale, {
          id: 'Q3',
          authorization: {
            installationId,
            workspaceId,
            ownerPrincipalId: actor.principalId,
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
      stale,
    ),
    { name: 'AuthorizationDeniedError' },
  );
} finally {
  await miniflare?.dispose();
  await rm(persist, { recursive: true, force: true });
}

function createMiniflare() {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-20',
    d1Databases: { DB: 'workshop-taproot-d1' },
    d1Persist: persist,
  });
}

async function createHostCapability(db) {
  const hostKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('taproot-d1-host-capability-key-32'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return createTaprootHostWriteCapability(db, options, hostKey);
}

async function assemble(db, capability) {
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
  const cursorGuard = await createInstallationDomainMutationGuard(
    db,
    options,
    capability,
    { domain: 'workshop.cursor.snapshot', capability: 'read' },
  );
  const authority = {
    getInstallationAuthorizationState: () => taskGuard.readCurrentState(),
    commitTaskMutation: (mutationDb, context, statement) =>
      firstRow(db, mutationDb, taskGuard, context, statement),
    commitMemoryMutation: (mutationDb, context, statement) =>
      firstRow(db, mutationDb, memoryGuard, context, statement),
    commitTaskBackfill: (mutationDb, context, state, statements) =>
      guardedBatch(
        db,
        mutationDb,
        taskBackfillGuard,
        context,
        state,
        statements,
      ),
    commitMemoryBackfill: (mutationDb, context, state, statements) =>
      guardedBatch(
        db,
        mutationDb,
        memoryBackfillGuard,
        context,
        state,
        statements,
      ),
    commitCursorSnapshot: (mutationDb, context, state, statements) =>
      guardedBatch(db, mutationDb, cursorGuard, context, state, statements),
  };
  const taprootAesKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('taproot-d1-cursor-aes-key-32!!!!'),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  const search = await createWorkshopSearchIntegrationV1({
    db,
    taproot: options,
    hostCapability: capability,
    installationId,
    registrationContext: actor,
  });
  return {
    authority,
    capability,
    search,
    taprootCursorCodec: createAuthorizationCursorCodec(taprootAesKey),
  };
}

function workshop(db, assembly, readerFactory) {
  return createWorkshopCore({
    persistence: db,
    authorization: assembly.authority,
    knowledge: {
      authorizedReader: (readerContext) =>
        readerFactory?.(readerContext) ??
        createAuthorizedTaproot(db, options, readerContext, {
          cursorCodec: assembly.taprootCursorCodec,
        }),
      health: async () => true,
    },
    diamondHealth: async () => true,
    cursorCodec: workshopCursorCodec(),
    search: assembly.search,
  });
}

function workshopCursorCodec() {
  const encoder = new TextEncoder();
  const aesKey = crypto.subtle.importKey(
    'raw',
    encoder.encode('workshop-d1-cursor-aes-key-32!!!'),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  const hmacKey = crypto.subtle.importKey(
    'raw',
    encoder.encode('workshop-d1-cursor-hmac-key-32!'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    currentGeneration: async () => 'd1-generation-1',
    async digest(purpose, value) {
      const signature = await crypto.subtle.sign(
        'HMAC',
        await hmacKey,
        new Uint8Array([...encoder.encode(purpose), 0, ...value]),
      );
      return Buffer.from(signature).toString('base64url');
    },
    async seal(generation, plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(generation) },
        await aesKey,
        plaintext,
      );
      return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
    },
    async open(generation, token) {
      const [iv, ciphertext] = token.split('.');
      if (!iv || !ciphertext) throw new Error('invalid cursor');
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: Buffer.from(iv, 'base64url'),
          additionalData: encoder.encode(generation),
        },
        await aesKey,
        Buffer.from(ciphertext, 'base64url'),
      );
      return new Uint8Array(plaintext);
    },
  };
}

async function firstRow(expectedDb, mutationDb, guard, context, statement) {
  const results = await guardedBatch(
    expectedDb,
    mutationDb,
    guard,
    context,
    await guard.readCurrentState(),
    [statement],
  );
  return results[0]?.results?.[0] ?? null;
}

async function guardedBatch(
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
      throw new WorkshopError('forbidden', 'Authorization denied', 403);
    return (await guard.batchWithExpectedRevision(context, statements)).results;
  } catch (error) {
    if (error instanceof InvalidAuthorizationError)
      throw new WorkshopError('forbidden', 'Authorization denied', 403);
    throw error;
  }
}

function context(authorizationRevision) {
  return {
    installationId,
    principalId: 'd1-agent',
    activeWorkspaceId: workspaceId,
    workspaceIds: [workspaceId],
    capabilities: [
      'read',
      'task-write',
      'memory-write',
      'knowledge:write',
      'search:admin',
    ],
    authorizationRevision,
  };
}

console.log('packed Taproot and Workshop persisted D1 conformance passed');
