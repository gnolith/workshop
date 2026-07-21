import { createWorkshopRuntime } from '@gnolith/workshop/server';
import {
  createWorkshopHealthHandler,
  createWorkshopMcpHandler,
} from '@gnolith/workshop/site';

interface Env {
  DB: import('@gnolith/workshop/server').D1DatabaseLike;
  CANARY_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runtime = createWorkshopRuntime({
      db: env.DB,
      knowledge: {
        async call() {
          throw new Error('Configure Taproot in the deployed Site runtime');
        },
        async health() {
          return false;
        },
      },
      async executeSparql() {
        throw new Error('Configure the Site Diamond query service');
      },
      async resolvePrincipal(candidate) {
        if (
          candidate.headers.get('authorization') !==
          `Bearer ${env.CANARY_TOKEN}`
        )
          return null;
        return {
          id: 'canary:verifier',
          capabilities: [
            'read',
            'task-write',
            'memory-write',
            'knowledge-write',
            'admin',
          ],
        };
      },
    });
    const path = new URL(request.url).pathname;
    if (path === '/health')
      return createWorkshopHealthHandler(runtime)(request);
    if (path === '/mcp') return createWorkshopMcpHandler(runtime)(request);
    return new Response('Not found', { status: 404 });
  },
};
