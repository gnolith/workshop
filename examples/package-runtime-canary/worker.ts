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
      authorization: {
        async getInstallationAuthorizationState() {
          return {
            installationId: 'canary:installation',
            authorizationRevision: 1,
            searchGeneration: 1,
          };
        },
        async commitTaskMutation<T>(_db, _context, mutation) {
          return mutation.first<T>();
        },
        async commitMemoryMutation<T>(_db, _context, mutation) {
          return mutation.first<T>();
        },
        async commitTaskBackfill(db, _context, _state, mutations) {
          return db.batch([...mutations]);
        },
        async commitMemoryBackfill(db, _context, _state, mutations) {
          return db.batch([...mutations]);
        },
        async commitCursorSnapshot(db, _context, _state, mutations) {
          return db.batch([...mutations]);
        },
      },
      knowledge: {
        authorizedReader() {
          return {
            async getEntity() {
              return null;
            },
            async searchEntities() {
              return { items: [], cursor: null };
            },
          };
        },
        health: async () => false,
      },
      diamondHealth: async () => false,
      cursorCodec: {
        currentGeneration: async () => 'canary-generation',
        async digest(purpose, value) {
          const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(env.CANARY_TOKEN),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const signature = await crypto.subtle.sign(
            'HMAC',
            key,
            new Uint8Array([...new TextEncoder().encode(purpose), 0, ...value]),
          );
          return Array.from(new Uint8Array(signature), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
        },
        async seal() {
          throw new Error('Pagination is outside this package canary');
        },
        async open() {
          throw new Error('Pagination is outside this package canary');
        },
      },
      async resolvePrincipal(candidate) {
        if (
          candidate.headers.get('authorization') !==
          `Bearer ${env.CANARY_TOKEN}`
        )
          return null;
        return {
          installationId: 'canary:installation',
          principalId: 'canary:verifier',
          activeWorkspaceId: 'canary:workspace',
          workspaceIds: ['canary:workspace'],
          capabilities: [
            'read',
            'task-write',
            'memory-write',
            'knowledge-write',
            'admin',
          ],
          authorizationRevision: 1,
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
