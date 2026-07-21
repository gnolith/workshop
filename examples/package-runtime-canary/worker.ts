import { createWorkshopRuntime } from '@gnolith/workshop/server';
import {
  createWorkshopHealthHandler,
  createWorkshopMcpHandler,
} from '@gnolith/workshop/site';

// Isolated package-runtime fixture only. Peer services are deliberately stubbed;
// this module is not a deployable Gnolith Site entry point.

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
          throw new Error(
            'This isolated package canary injects no Taproot host',
          );
        },
        async health() {
          return false;
        },
      },
      async executeSparql() {
        throw new Error('This isolated package canary injects no Diamond host');
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
