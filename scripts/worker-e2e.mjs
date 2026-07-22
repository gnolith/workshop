import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';
import { workshopMigrations } from '../dist/migrations.js';

const scriptPath = '.wrangler/package-runtime-canary/worker.js';
const miniflare = new Miniflare({
  modules: true,
  scriptPath,
  compatibilityDate: '2026-07-20',
  bindings: { CANARY_TOKEN: 'worker-e2e-token' },
  d1Databases: { DB: `worker-e2e-${randomUUID()}` },
});

try {
  const db = await miniflare.getD1Database('DB');
  for (const migration of workshopMigrations) {
    for (const statement of migration.sql.split(/;\s*(?:\r?\n|$)/u)) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }

  const call = async (id, method, params = {}) => {
    const response = await miniflare.dispatchFetch(
      'https://worker.example/mcp',
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer worker-e2e-token',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };

  const coldStarted = performance.now();
  const initialized = await call(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'worker-e2e', version: '1.0.0' },
  });
  const coldRequestMs = Number((performance.now() - coldStarted).toFixed(2));
  assert.equal(initialized.result.protocolVersion, '2025-11-25');

  const created = await call(2, 'tools/call', {
    name: 'create_task',
    arguments: {
      description: 'Isolated package-runtime task',
      prompt: 'Verify the published package in a local Worker runtime.',
    },
  });
  assert.equal(created.result.isError, true);
  assert.match(
    created.result.structuredContent.error.message,
    /search producer is not registered/u,
  );

  const listed = await call(3, 'tools/call', {
    name: 'list_tasks',
    arguments: {},
  });
  assert.equal(listed.result.structuredContent.items.length, 0);
  console.log(
    `isolated package-runtime Worker lifecycle passed (cold initialize ${coldRequestMs}ms)`,
  );
} finally {
  await miniflare.dispose();
}
