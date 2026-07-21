import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
  const runtime = createWorkshopRuntime({
    db,
    executeSparql: async (query) =>
      /ASK/iu.test(query)
        ? { type: 'boolean', data: true, truncated: false }
        : { type: 'bindings', data: [], count: 0, truncated: false },
    knowledge: {
      async call(call) {
        return { entityId: call.input.entityId ?? 'Q1', newRevision: 2 };
      },
      async health() {
        return true;
      },
    },
    resolvePrincipal: async () => ({
      id: 'performance',
      capabilities: ['read', 'task-write', 'knowledge-write'],
    }),
  });
  for (let index = 0; index < 20; index++) {
    await runtime.tasks.create({
      description: `Performance task ${index}`,
      prompt: 'Measure bounded Workshop operations.',
    });
  }
  const packetTask = await runtime.tasks.create({
    description: 'Packet performance',
    prompt: 'Compile current context.',
    contextQueries: [{ sparql: 'ASK { }' }],
  });
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
    taskSearchMs: await elapsed(() => runtime.tasks.list({ text: 'bounded' })),
    taskPacketMs: await elapsed(() => runtime.packets.get(packetTask.id)),
    mcpInitializeMs: await elapsed(() =>
      mcp.handle(mcpRequest(1, 'initialize')),
    ),
    mcpToolsListMs: await elapsed(() =>
      mcp.handle(mcpRequest(2, 'tools/list')),
    ),
    knowledgeCallMs: await elapsed(() =>
      runtime.knowledge.call(
        { name: 'get_entity', input: { entityId: 'Q1' } },
        { principalId: 'performance' },
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
