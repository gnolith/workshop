import { Miniflare } from 'miniflare';
import type { WorkshopPrincipal } from '../src/protocol.js';
import { WorkshopError } from '../src/protocol/errors.js';
import { createWorkshopRuntime } from '../src/server/context.js';
import type { D1DatabaseLike } from '../src/server/database.js';
import type { WorkshopCursorCodec } from '../src/server/cursor.js';
import type { WorkshopAuthorizationAuthority } from '../src/server/authorization.js';
import { workshopMigrations } from '../src/migrations.js';
import {
  bootstrapTaprootAuthorization,
  createTaprootHostWriteCapability,
  initializeTaproot,
} from '@gnolith/taproot';
import { createWorkshopSearchIntegrationV1 } from '../src/server/search.js';

export async function createTestContext() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-20',
    d1Databases: { DB: `workshop-${crypto.randomUUID()}` },
  });
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  const taproot = { baseIri: 'https://workshop-test.example' };
  await initializeTaproot(db, taproot);
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hostCapability = createTaprootHostWriteCapability(db, taproot, key);
  await bootstrapTaprootAuthorization(
    db,
    taproot,
    hostCapability,
    TEST_AUTHORIZATION.installationId,
  );
  for (const migration of workshopMigrations) {
    for (const statement of migration.sql.split(/;\s*(?:\r?\n|$)/u)) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  const authorization: WorkshopAuthorizationAuthority = {
    async getInstallationAuthorizationState() {
      return {
        installationId: TEST_AUTHORIZATION.installationId,
        authorizationRevision: TEST_AUTHORIZATION.authorizationRevision,
        searchGeneration: 1,
      };
    },
    async commitTaskMutation<T>(
      _db: D1DatabaseLike,
      _context: WorkshopPrincipal,
      mutation: import('../src/server/database.js').D1PreparedStatementLike,
    ) {
      if (!_context.capabilities.includes('task-write'))
        throw new WorkshopError('forbidden', 'Authorization denied');
      return mutation.first<T>();
    },
    async commitMemoryMutation<T>(
      _db: D1DatabaseLike,
      _context: WorkshopPrincipal,
      mutation: import('../src/server/database.js').D1PreparedStatementLike,
    ) {
      if (!_context.capabilities.includes('memory-write'))
        throw new WorkshopError('forbidden', 'Authorization denied');
      return mutation.first<T>();
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
  let tick = Date.parse('2026-07-20T12:00:00.000Z');
  const knowledgeCalls: Array<{
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const knowledgeReader = {
    async getEntity(entityId: string) {
      knowledgeCalls.push({ name: 'get_entity', input: { entityId } });
      return { entityId, entity: { id: entityId }, revision: 1 };
    },
    async searchEntities(query: string, options?: Record<string, unknown>) {
      knowledgeCalls.push({
        name: 'search_entities',
        input: { query, ...(options ?? {}) },
      });
      return { items: [], cursor: null };
    },
  };
  const knowledge = {
    authorizedReader() {
      return knowledgeReader;
    },
    async health() {
      return true;
    },
  };
  const cursorCodec = createTestCursorCodec();
  const search = await createWorkshopSearchIntegrationV1({
    db,
    taproot,
    hostCapability,
    installationId: TEST_AUTHORIZATION.installationId,
    registrationContext: TEST_AUTHORIZATION,
    clock: () => new Date(++tick),
  });
  for (const domain of [search.task, search.memory, search.prompt])
    await domain.producer.adoptLegacyPage(TEST_AUTHORIZATION, { limit: 100 });
  const runtime = createWorkshopRuntime({
    db,
    authorization,
    knowledge,
    cursorCodec,
    diamondHealth: async () => true,
    clock: () => new Date(++tick),
    resolvePrincipal: async (request) => principalFor(request),
    search,
  });
  return {
    miniflare,
    db,
    authorization,
    cursorCodec,
    runtime,
    search,
    knowledgeCalls,
    dispose: () => miniflare.dispose(),
  };
}

export function createTestCursorCodec(): WorkshopCursorCodec & {
  generation: string;
} {
  const values = new Map<string, Uint8Array>();
  const key = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('workshop-test-cursor-hmac-key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    generation: 'test-generation-1',
    async currentGeneration() {
      return this.generation;
    },
    async digest(purpose, value) {
      const signature = await crypto.subtle.sign(
        'HMAC',
        await key,
        new Uint8Array([...new TextEncoder().encode(purpose), 0, ...value]),
      );
      return Buffer.from(signature).toString('hex');
    },
    async seal(generation, plaintext) {
      const token = `opaque.${generation}.${crypto.randomUUID()}`;
      values.set(token, plaintext.slice());
      return token;
    },
    async open(generation, token) {
      const value = values.get(token);
      if (!value || !token.startsWith(`opaque.${generation}.`))
        throw new Error('invalid token');
      return value.slice();
    },
  };
}

export function createTestKnowledgeOptions() {
  return {
    authorizedReader: () => ({
      async getEntity(entityId: string) {
        return { entityId, entity: { id: entityId }, revision: 1 };
      },
      async searchEntities() {
        return { items: [], cursor: null };
      },
    }),
    health: async () => true,
  };
}

function principalFor(request: Request): WorkshopPrincipal | null {
  const token = request.headers.get('authorization');
  if (token === 'Bearer admin') {
    return {
      ...TEST_AUTHORIZATION,
      principalId: 'agent:admin',
      capabilities: ['admin'],
    };
  }
  if (token === 'Bearer full') {
    return {
      ...TEST_AUTHORIZATION,
      principalId: 'agent:full',
      capabilities: [
        'read',
        'task-write',
        'knowledge-write',
        'memory-write',
        'admin',
        'prompt-write',
        'search:admin',
      ],
    };
  }
  if (token === 'Bearer writer') {
    return {
      ...TEST_AUTHORIZATION,
      principalId: 'agent:writer',
      capabilities: [
        'read',
        'task-write',
        'knowledge-write',
        'memory-write',
        'prompt-write',
      ],
    };
  }
  if (token === 'Bearer reader') {
    return {
      ...TEST_AUTHORIZATION,
      principalId: 'agent:reader',
      capabilities: ['read'],
    };
  }
  return null;
}

export const TEST_AUTHORIZATION: WorkshopPrincipal = {
  installationId: 'installation:test',
  principalId: 'agent:test',
  activeWorkspaceId: 'workspace:test',
  workspaceIds: ['workspace:test'],
  capabilities: [
    'read',
    'task-write',
    'knowledge-write',
    'memory-write',
    'admin',
    'prompt-write',
    'search:admin',
  ],
  authorizationRevision: 1,
};

export function mcpRequest(
  body: unknown,
  token = 'full',
  protocol?: string,
): Request {
  return new Request('https://site.example/api/workshop/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
    },
    body: JSON.stringify(body),
  });
}
