import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { createWorkshopMcpServer } from '../dist/mcp.js';
import { workshopMigrations } from '../dist/migrations.js';
import { createWorkshopRuntime } from '../dist/server.js';

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: { DB: 'workshop-performance' },
});

const elapsed = async (operation) => {
  const start = performance.now();
  await operation();
  return Number((performance.now() - start).toFixed(2));
};

try {
  const db = await miniflare.getD1Database('DB');
  for (const migration of workshopMigrations) {
    for (const statement of migration.sql.split(/;\s*(?:\r?\n|$)/u)) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  const authorizationContext = {
    installationId: 'performance:installation',
    principalId: 'performance',
    activeWorkspaceId: 'performance:workspace',
    workspaceIds: ['performance:workspace'],
    capabilities: ['read', 'task-write', 'knowledge-write'],
    authorizationRevision: 1,
  };
  const runtime = createWorkshopRuntime({
    db,
    authorization: {
      async getInstallationAuthorizationState() {
        return {
          installationId: authorizationContext.installationId,
          authorizationRevision: 1,
          searchGeneration: 1,
        };
      },
      async commitTaskMutation(_db, _context, mutation) {
        return mutation.first();
      },
      async commitMemoryMutation(_db, _context, mutation) {
        return mutation.first();
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
    },
    knowledge: {
      authorizedReader() {
        return {
          async getEntity(entityId) {
            return { entityId, entity: { id: entityId }, revision: 1 };
          },
          async searchEntities() {
            return { items: [], cursor: null };
          },
        };
      },
      health: async () => true,
    },
    diamondHealth: async () => true,
    cursorCodec: opaqueCursorCodec(),
    resolvePrincipal: async () => authorizationContext,
  });
  for (let index = 0; index < 20; index++) {
    await runtime.tasks.create(
      {
        description: `Performance task ${index}`,
        prompt: 'Measure bounded Workshop operations.',
      },
      authorizationContext,
    );
  }
  const packetTask = await runtime.tasks.create(
    {
      description: 'Packet performance',
      prompt: 'Compile an authorized packet without an unscoped graph query.',
    },
    authorizationContext,
  );
  const mcp = createWorkshopMcpServer(runtime);
  const mcpRequest = (id, method) =>
    new Request('https://performance.example/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer performance',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params:
          method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'performance', version: '1' },
              }
            : {},
      }),
    });
  const metrics = {
    taskSearchMs: await elapsed(() =>
      runtime.tasks.list({ text: 'bounded' }, authorizationContext),
    ),
    taskPacketMs: await elapsed(() =>
      runtime.packets.get(packetTask.id, authorizationContext),
    ),
    mcpInitializeMs: await elapsed(() =>
      mcp.handle(mcpRequest(1, 'initialize')),
    ),
    mcpToolsListMs: await elapsed(() =>
      mcp.handle(mcpRequest(2, 'tools/list')),
    ),
    knowledgeCallMs: await elapsed(() =>
      runtime.knowledge.call(
        { name: 'get_entity', input: { entityId: 'Q1' } },
        authorizationContext,
      ),
    ),
  };
  for (const [name, value] of Object.entries(metrics)) {
    assert.ok(value < 2_000, `${name} exceeded the 2s local regression bound`);
  }
  const uiFiles = readdirSync('dist/ui', {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => readFileSync(`${entry.parentPath}/${entry.name}`));
  const uiBytes = uiFiles.reduce((sum, file) => sum + file.byteLength, 0);
  const uiGzipBytes = gzipSync(Buffer.concat(uiFiles)).byteLength;
  console.log(JSON.stringify({ ...metrics, uiBytes, uiGzipBytes }));
} finally {
  await miniflare.dispose();
}

function opaqueCursorCodec() {
  const values = new Map();
  return {
    currentGeneration: async () => 'performance-generation',
    async digest(purpose, value) {
      return createHmac('sha256', 'workshop-performance-cursor-key')
        .update(purpose)
        .update('\0')
        .update(value)
        .digest('hex');
    },
    async seal(generation, plaintext) {
      const token = `opaque.${generation}.${randomUUID()}`;
      values.set(token, plaintext.slice());
      return token;
    },
    async open(generation, token) {
      const value = values.get(token);
      if (!value || !token.startsWith(`opaque.${generation}.`))
        throw new Error('invalid cursor');
      return value.slice();
    },
  };
}
