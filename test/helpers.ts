import { Miniflare } from 'miniflare';
import type { KnowledgeService } from '../src/protocol/knowledge.js';
import type { WorkshopPrincipal } from '../src/protocol.js';
import { createWorkshopRuntime } from '../src/server/context.js';
import type { D1DatabaseLike } from '../src/server/database.js';
import { workshopMigrations } from '../src/migrations.js';

export async function createTestContext() {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-20',
    d1Databases: { DB: `workshop-${crypto.randomUUID()}` },
  });
  const db = (await miniflare.getD1Database('DB')) as unknown as D1DatabaseLike;
  for (const migration of workshopMigrations) {
    for (const statement of migration.sql.split(/;\s*(?:\r?\n|$)/u)) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  let tick = Date.parse('2026-07-20T12:00:00.000Z');
  const knowledgeCalls: Array<{
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const knowledge: KnowledgeService = {
    async call(call) {
      knowledgeCalls.push({ name: call.name, input: { ...call.input } });
      return {
        entityId: call.input.entityId ?? 'Q1',
        previousRevision: null,
        newRevision: 1,
        entity: call.input,
      };
    },
    async health() {
      return true;
    },
  };
  const runtime = createWorkshopRuntime({
    db,
    knowledge,
    clock: () => new Date(++tick),
    executeSparql: async (query, options) =>
      /ASK/iu.test(query)
        ? { type: 'boolean', data: true, truncated: false }
        : {
            type: 'bindings',
            data: [{ entity: 'https://example.test/Q1' }].slice(
              0,
              options.resultLimit,
            ),
            count: 1,
            truncated: false,
          },
    resolvePrincipal: async (request) => principalFor(request),
  });
  return {
    miniflare,
    db,
    runtime,
    knowledgeCalls,
    dispose: () => miniflare.dispose(),
  };
}

function principalFor(request: Request): WorkshopPrincipal | null {
  const token = request.headers.get('authorization');
  if (token === 'Bearer admin') {
    return {
      id: 'agent:admin',
      capabilities: [
        'read',
        'task-write',
        'knowledge-write',
        'memory-write',
        'admin',
      ],
    };
  }
  if (token === 'Bearer writer') {
    return {
      id: 'agent:writer',
      capabilities: ['read', 'task-write', 'knowledge-write', 'memory-write'],
    };
  }
  if (token === 'Bearer reader') {
    return { id: 'agent:reader', capabilities: ['read'] };
  }
  return null;
}

export function mcpRequest(
  body: unknown,
  token = 'admin',
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
