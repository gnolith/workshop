import { createWorkshopMcpServer } from '../mcp.js';
import { createWorkshopToolDispatcher } from '../mcp/dispatcher.js';
import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type { WorkshopPrincipal } from '../protocol.js';
import {
  authorize,
  requireCapability,
  requireCurrentAuthorization,
} from '../server/authorization.js';
import type { WorkshopRuntime } from '../server/context.js';
import { HealthService } from '../server/health.js';
import { resolveLimits } from '../server/limits.js';
import { observeSafely } from '../server/observability.js';

export type WorkshopRouteHandler = (request: Request) => Promise<Response>;

export function createTasksHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    if (request.method === 'GET') {
      const actor = authorize(principal, 'read');
      return runtime.tasks.list(queryObject(request), actor);
    }
    if (request.method === 'POST') {
      const actor = authorize(principal, 'task-write');
      return runtime.tasks.create(
        (await json(request, runtime)) as never,
        actor,
      );
    }
    throw methodNotAllowed('GET, POST');
  });
}

export function createTaskHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    const id = pathValue(request, 'tasks');
    if (request.method === 'GET') {
      const actor = authorize(principal, 'read');
      return runtime.tasks.get(id, actor);
    }
    if (request.method === 'PATCH') {
      const actor = authorize(principal, 'task-write');
      return runtime.tasks.update(
        id,
        (await json(request, runtime)) as never,
        actor,
      );
    }
    if (request.method === 'DELETE') {
      const actor = authorize(principal, 'task-write');
      const revision = request.headers.get('x-workshop-revision');
      return runtime.tasks.archive(
        id,
        {
          ...(revision === null
            ? { expectedUpdatedAt: requiredHeader(request, 'if-match') }
            : { expectedRevision: Number(revision) }),
        },
        actor,
      );
    }
    throw methodNotAllowed('GET, PATCH, DELETE');
  });
}

export function createTaskPacketHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'GET');
    const actor = authorize(principal, 'read');
    return runtime.packets.get(
      pathValue(request, 'tasks'),
      actor,
      request.signal,
    );
  });
}

export function createTaskHistoryHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'GET');
    const limit = queryLimit(request);
    return runtime.tasks.history(
      pathValue(request, 'tasks'),
      authorize(principal, 'read'),
      limit === undefined ? {} : { limit },
    );
  });
}

export function createTaskClaimHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'POST');
    const actor = authorize(principal, 'task-write');
    return runtime.tasks.claim(pathValue(request, 'tasks'), actor);
  });
}

export function createTaskCompleteHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'POST');
    const actor = authorize(principal, 'task-write');
    const input = await json(request, runtime);
    return runtime.tasks.complete(
      pathValue(request, 'tasks'),
      input.result,
      actor,
    );
  });
}

export function createMemoriesHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'GET');
    const actor = authorize(principal, 'read');
    return runtime.memories.list(queryObject(request), actor);
  });
}

export function createMemoryHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    const slug = pathValue(request, 'memories');
    if (request.method === 'GET') {
      const actor = authorize(principal, 'read');
      return runtime.memories.get(slug, actor);
    }
    if (request.method === 'PUT') {
      const actor = authorize(principal, 'memory-write');
      return runtime.memories.upsert(
        slug,
        (await json(request, runtime)) as never,
        actor,
      );
    }
    if (request.method === 'DELETE') {
      await runtime.memories.delete(
        slug,
        Number(requiredHeader(request, 'x-workshop-revision')),
        authorize(principal, 'memory-write'),
      );
      return { deleted: true };
    }
    throw methodNotAllowed('GET, PUT, DELETE');
  });
}

export function createMemoryHistoryHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'GET');
    const limit = queryLimit(request);
    return runtime.memories.history(
      pathValue(request, 'memories'),
      authorize(principal, 'read'),
      limit === undefined ? {} : { limit },
    );
  });
}

export function createPromptsHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    const prompts = requiredPrompts(runtime);
    if (request.method === 'GET')
      return prompts.list(queryObject(request), authorize(principal, 'read'));
    if (request.method === 'POST')
      return prompts.create(
        (await json(request, runtime)) as never,
        authorize(principal, 'prompt-write'),
      );
    throw methodNotAllowed('GET, POST');
  });
}

export function createPromptHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    const prompts = requiredPrompts(runtime);
    const id = pathValue(request, 'prompts');
    if (request.method === 'GET')
      return prompts.get(id, authorize(principal, 'read'));
    if (request.method === 'PATCH')
      return prompts.update(
        id,
        (await json(request, runtime)) as never,
        authorize(principal, 'prompt-write'),
      );
    if (request.method === 'DELETE') {
      await prompts.delete(
        id,
        Number(requiredHeader(request, 'x-workshop-revision')),
        authorize(principal, 'prompt-write'),
      );
      return { deleted: true };
    }
    throw methodNotAllowed('GET, PATCH, DELETE');
  });
}

export function createPromptHistoryHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'GET');
    const limit = queryLimit(request);
    return requiredPrompts(runtime).history(
      pathValue(request, 'prompts'),
      authorize(principal, 'read'),
      limit === undefined ? {} : { limit },
    );
  });
}

export function createSearchHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  return route(runtime, async (request, principal) => {
    only(request, 'POST');
    if (!runtime.search)
      throw new WorkshopError(
        'internal_error',
        'Search integration is not registered',
      );
    return runtime.search.search(
      (await json(request, runtime)) as never,
      authorize(principal, 'read'),
    );
  });
}

export function createSearchAdminHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  const dispatcher = createWorkshopToolDispatcher(runtime);
  return route(runtime, async (request, principal) => {
    const actor = authorize(principal, 'search:admin');
    if (request.method === 'GET') {
      if (!runtime.search)
        throw new WorkshopError(
          'internal_error',
          'Search integration is not registered',
        );
      return {
        materialization: await runtime.search.materialization.health(actor),
        semantic: await runtime.search.semantic.status(actor),
      };
    }
    only(request, 'POST');
    const result = await dispatcher.callTool(
      { name: 'search_admin', arguments: await json(request, runtime) },
      {
        principal: actor,
        requestId: request.headers.get('x-request-id') ?? crypto.randomUUID(),
        signal: request.signal,
      },
    );
    if (!result.ok)
      throw new WorkshopError(
        result.failure.error.code,
        result.failure.error.message,
        undefined,
        result.failure.error.details,
      );
    return result.value;
  });
}

function requiredPrompts(runtime: WorkshopRuntime) {
  if (!runtime.prompts)
    throw new WorkshopError(
      'internal_error',
      'Prompt producer is not registered',
    );
  return runtime.prompts;
}

export function createWorkshopMcpHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  const server = createWorkshopMcpServer(runtime);
  return (request) => server.handle(request);
}

export function createWorkshopHealthHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  const health = healthService(runtime);
  return async (request) => {
    try {
      only(request, 'GET');
      const body = await health.publicHealth();
      return Response.json(body, {
        status: body.status === 'ok' ? 200 : 503,
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createWorkshopProbeHandler(
  runtime: WorkshopRuntime,
): WorkshopRouteHandler {
  const health = healthService(runtime);
  return route(runtime, async (request, principal) => {
    const actor = await requireCurrentAuthorization(
      runtime.authorization,
      authorize(principal, 'admin'),
    );
    if (request.method === 'GET') return health.inspect();
    if (request.method !== 'POST') throw methodNotAllowed('GET, POST');
    requireCapability(actor, 'task-write');
    requireCapability(actor, 'memory-write');
    const key = crypto.randomUUID();
    const slug = `probe-${key}`;
    const memory = await runtime.memories.upsert(
      slug,
      {
        description: 'Temporary Workshop semantic probe',
        content: 'Probe guidance',
      },
      actor,
    );
    const task = await runtime.tasks.create(
      {
        idempotencyKey: `probe:${key}`,
        description: 'Temporary Workshop semantic probe',
        prompt: 'Verify the Workshop lifecycle.',
        memorySlugs: [slug],
      },
      actor,
    );
    const packet = await runtime.packets.get(task.id, actor, request.signal);
    const claimed = await runtime.tasks.claim(task.id, actor);
    const completed = await runtime.tasks.complete(
      task.id,
      'Workshop lifecycle probe completed.',
      actor,
    );
    const archiveTask = await runtime.tasks.create(
      {
        idempotencyKey: `probe:${key}:archive`,
        description: 'Temporary Workshop archive probe',
        prompt: 'Verify the Workshop archive transition.',
      },
      actor,
    );
    const archived = await runtime.tasks.archive(
      archiveTask.id,
      {
        expectedUpdatedAt: archiveTask.updatedAt,
      },
      actor,
    );
    return { memory, task, packet, claimed, completed, archiveTask, archived };
  });
}

function route(
  runtime: WorkshopRuntime,
  handler: (
    request: Request,
    principal: WorkshopPrincipal | null,
  ) => Promise<unknown>,
): WorkshopRouteHandler {
  return async (request) => {
    if (request.method === 'OPTIONS') return preflight(request, runtime);
    try {
      validateOrigin(request, runtime);
      const principal = await runtime.resolvePrincipal(request);
      const body = await handler(request, principal);
      return jsonResponse(body, 200, request, runtime);
    } catch (error) {
      const normalized = normalizeWorkshopError(error);
      if (
        normalized.code === 'unauthenticated' ||
        normalized.code === 'forbidden'
      ) {
        await observeSafely(runtime.observe, {
          operation: 'authorization.failure',
          outcome: 'error',
          durationMs: 0,
          errorCode: normalized.code,
          ...(request.headers.get('x-request-id')
            ? { requestId: request.headers.get('x-request-id')! }
            : {}),
        });
      }
      return errorResponse(error, request, runtime);
    }
  };
}

function healthService(runtime: WorkshopRuntime): HealthService {
  return new HealthService({
    db: runtime.db,
    diamondHealth: runtime.diamondHealth,
    knowledge: runtime.knowledge,
    constructMcp: () => createWorkshopMcpServer(runtime),
  });
}

async function json(
  request: Request,
  runtime: WorkshopRuntime,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0];
  if (contentType !== 'application/json') {
    throw new WorkshopError('bad_request', 'Expected application/json', 415);
  }
  const max = resolveLimits(runtime.limits).maxMcpRequestBytes;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    throw new WorkshopError('limit_exceeded', 'Request body is too large');
  }
  if (!request.body)
    throw new WorkshopError('bad_request', 'Missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new WorkshopError('limit_exceeded', 'Request body is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('object required');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new WorkshopError('bad_request', 'Invalid JSON object body');
  }
}

function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

function queryLimit(request: Request): number | undefined {
  const value = new URL(request.url).searchParams.get('limit');
  return value === null ? undefined : Number(value);
}

function pathValue(request: Request, segment: string): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = parts.lastIndexOf(segment);
  const value = parts[index + 1];
  if (!value) {
    throw new WorkshopError(
      'bad_request',
      `Missing path value after ${segment}`,
    );
  }
  return decodeURIComponent(value);
}

function only(request: Request, method: string): void {
  if (request.method !== method) throw methodNotAllowed(method);
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) {
    throw new WorkshopError(
      'bad_request',
      `The ${name} header is required`,
      400,
      { field: name },
    );
  }
  return value;
}

function methodNotAllowed(allow: string): WorkshopError {
  return new WorkshopError(
    'bad_request',
    `Method not allowed; use ${allow}`,
    405,
    {
      allow,
    },
  );
}

function validateOrigin(request: Request, runtime: WorkshopRuntime): void {
  const origin = request.headers.get('origin');
  if (!origin || origin === new URL(request.url).origin) return;
  const allowed =
    typeof runtime.corsOrigin === 'function'
      ? runtime.corsOrigin(request)
      : runtime.corsOrigin;
  if (origin !== allowed)
    throw new WorkshopError('forbidden', 'Origin is not allowed');
}

function cors(request: Request, runtime: WorkshopRuntime): HeadersInit {
  const origin = request.headers.get('origin');
  const allowed =
    typeof runtime.corsOrigin === 'function'
      ? runtime.corsOrigin(request)
      : runtime.corsOrigin;
  return origin &&
    (origin === new URL(request.url).origin || origin === allowed)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

function preflight(request: Request, runtime: WorkshopRuntime): Response {
  try {
    validateOrigin(request, runtime);
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(request, runtime),
        'access-control-allow-methods':
          'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers':
          'Authorization, Content-Type, If-Match, X-Workshop-Revision, X-Request-Id',
      },
    });
  } catch (error) {
    return errorResponse(error, request, runtime);
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  request: Request,
  runtime: WorkshopRuntime,
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...cors(request, runtime),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function errorResponse(
  error: unknown,
  request?: Request,
  runtime?: WorkshopRuntime,
): Response {
  const normalized = normalizeWorkshopError(error);
  return Response.json(
    { error: normalized.toJSON() },
    {
      status: normalized.status,
      headers: {
        ...(request && runtime ? cors(request, runtime) : {}),
        'cache-control': 'no-store',
      },
    },
  );
}
