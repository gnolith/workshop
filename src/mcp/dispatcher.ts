import type { KnowledgeService } from '../protocol/knowledge.js';
import {
  WorkshopError,
  normalizeWorkshopError,
  type WorkshopErrorBody,
} from '../protocol/errors.js';
import type { WorkshopPrincipal } from '../protocol.js';
import { authorize } from '../server/authorization.js';
import { KNOWLEDGE_TOOL_NAMES } from '../server/knowledge.js';
import type { WorkshopLimits } from '../server/limits.js';
import { resolveLimits } from '../server/limits.js';
import type { MemoryService } from '../server/memories.js';
import {
  observed,
  observeSafely,
  type ObserveWorkshop,
} from '../server/observability.js';
import type { PacketService } from '../server/packets.js';
import type { SparqlService } from '../server/sparql.js';
import type { TaskService } from '../server/tasks.js';
import { workshopTools, type WorkshopToolDefinition } from './tools.js';

/** The transport-neutral services needed to execute Workshop tools. */
export interface WorkshopToolRuntime {
  readonly tasks: TaskService;
  readonly memories: MemoryService;
  readonly packets: PacketService;
  readonly sparql: SparqlService;
  readonly knowledge: KnowledgeService;
  readonly limits?: Partial<WorkshopLimits>;
  readonly observe?: ObserveWorkshop;
}

export interface WorkshopToolCall {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface WorkshopToolDispatchContext {
  readonly principal: WorkshopPrincipal | null;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export type WorkshopDispatchErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'operation';

export interface WorkshopDispatchFailure {
  readonly kind: WorkshopDispatchErrorKind;
  readonly error: WorkshopErrorBody;
}

export type WorkshopDispatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: WorkshopDispatchFailure };

export interface WorkshopToolDispatcher {
  readonly tools: readonly WorkshopToolDefinition[];
  listTools(
    principal: WorkshopPrincipal | null,
  ): WorkshopDispatchResult<readonly WorkshopToolDefinition[]>;
  callTool(
    call: WorkshopToolCall,
    context: WorkshopToolDispatchContext,
  ): Promise<WorkshopDispatchResult<unknown>>;
}

const DIRECT_TOOL_NAMES = [
  'list_tasks',
  'search_tasks',
  'get_task_packet',
  'create_task',
  'update_task',
  'archive_task',
  'claim_task',
  'complete_task',
  'list_memories',
  'get_memory',
  'upsert_memory',
  'validate_sparql',
  'dry_run_sparql',
  'query_sparql',
] as const;

const KNOWLEDGE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  KNOWLEDGE_TOOL_NAMES,
);
const HANDLED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DIRECT_TOOL_NAMES,
  ...KNOWLEDGE_TOOL_NAMES,
]);

export function createWorkshopToolDispatcher(
  runtime: WorkshopToolRuntime,
): WorkshopToolDispatcher {
  assertCompleteRegistry();
  const definitions = new Map(
    workshopTools.map((definition) => [definition.name, definition] as const),
  );

  return {
    tools: workshopTools,
    listTools(principal) {
      const authorized = authorizeResult(principal, 'read');
      if (!authorized.ok) return authorized;
      return {
        ok: true,
        value: workshopTools.filter((tool) =>
          hasCapability(authorized.value, tool.capability),
        ),
      };
    },
    async callTool(call, context) {
      if (!context.principal) {
        return authorizationFailure(
          new WorkshopError('unauthenticated', 'Authentication is required'),
        );
      }
      const definition = definitions.get(call.name);
      if (!definition) {
        return {
          ok: false,
          failure: {
            kind: 'unknown_tool',
            error: new WorkshopError(
              'bad_request',
              `Unknown tool ${call.name}`,
              400,
              { tool: call.name },
            ).toJSON(),
          },
        };
      }
      const authorized = authorizeResult(
        context.principal,
        definition.capability,
      );
      if (!authorized.ok) {
        await observeAuthorizationFailure(runtime, authorized.failure, context);
        return authorized;
      }

      try {
        const value = await observed(
          runtime.observe,
          {
            operation: 'mcp.call',
            principalId: authorized.value.id,
            requestId: context.requestId,
          },
          () =>
            withTimeout(
              executeTool(
                runtime,
                authorized.value,
                call.name,
                { ...(call.arguments ?? {}) },
                context.requestId,
                context.signal ?? new AbortController().signal,
              ),
              resolveLimits(runtime.limits).toolTimeoutMs,
            ),
        );
        return { ok: true, value };
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        return {
          ok: false,
          failure: {
            kind:
              normalized.code === 'bad_request' ||
              normalized.code === 'validation_failed'
                ? 'invalid_arguments'
                : 'operation',
            error: normalized.toJSON(),
          },
        };
      }
    },
  };
}

async function executeTool(
  runtime: WorkshopToolRuntime,
  principal: WorkshopPrincipal,
  name: string,
  input: Record<string, unknown>,
  requestId: string,
  signal: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case 'list_tasks':
    case 'search_tasks':
      return runtime.tasks.list(input);
    case 'get_task_packet':
      return runtime.packets.get(text(input.id, 'id'), signal);
    case 'create_task':
      return runtime.tasks.create(input as never, principal.id);
    case 'update_task': {
      const { id, ...update } = input;
      return runtime.tasks.update(
        text(id, 'id'),
        update as never,
        principal.id,
      );
    }
    case 'archive_task': {
      const { id, expectedRevision, expectedUpdatedAt } = input;
      return runtime.tasks.archive(text(id, 'id'), {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        principalId: principal.id,
      } as never);
    }
    case 'claim_task':
      return runtime.tasks.claim(text(input.id, 'id'), principal.id);
    case 'complete_task':
      return runtime.tasks.complete(
        text(input.id, 'id'),
        input.result,
        principal.id,
      );
    case 'list_memories':
      return runtime.memories.list(input);
    case 'get_memory':
      return runtime.memories.get(text(input.slug, 'slug'));
    case 'upsert_memory': {
      const { slug, ...memory } = input;
      return runtime.memories.upsert(
        text(slug, 'slug'),
        memory as never,
        principal.id,
      );
    }
    case 'validate_sparql':
      return runtime.sparql.validate(input.sparql);
    case 'dry_run_sparql':
      return runtime.sparql.dryRun(text(input.sparql, 'sparql'), { signal });
    case 'query_sparql':
      return runtime.sparql.query(text(input.sparql, 'sparql'), { signal });
  }

  if (KNOWLEDGE_TOOL_NAME_SET.has(name)) {
    return runtime.knowledge.call(
      { name, input },
      { principalId: principal.id, requestId },
    );
  }
  throw new WorkshopError('internal_error', `Tool ${name} has no handler`);
}

function authorizeResult(
  principal: WorkshopPrincipal | null,
  capability: WorkshopToolDefinition['capability'],
): WorkshopDispatchResult<WorkshopPrincipal> {
  try {
    return { ok: true, value: authorize(principal, capability) };
  } catch (error) {
    return authorizationFailure(normalizeWorkshopError(error));
  }
}

function authorizationFailure(
  error: WorkshopError,
): WorkshopDispatchResult<never> {
  return {
    ok: false,
    failure: {
      kind: error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
      error: error.toJSON(),
    },
  };
}

async function observeAuthorizationFailure(
  runtime: WorkshopToolRuntime,
  failure: WorkshopDispatchFailure,
  context: WorkshopToolDispatchContext,
): Promise<void> {
  await observeSafely(runtime.observe, {
    operation: 'authorization.failure',
    outcome: 'error',
    durationMs: 0,
    errorCode: failure.error.code,
    requestId: context.requestId,
    ...(context.principal ? { principalId: context.principal.id } : {}),
  });
}

function hasCapability(
  principal: WorkshopPrincipal,
  capability: WorkshopToolDefinition['capability'],
): boolean {
  return (
    principal.capabilities.includes(capability) ||
    principal.capabilities.includes('admin')
  );
}

function assertCompleteRegistry(): void {
  const schemaNames = new Set<string>();
  for (const definition of workshopTools) {
    if (schemaNames.has(definition.name)) {
      throw new WorkshopError(
        'internal_error',
        `Duplicate Workshop tool ${definition.name}`,
      );
    }
    schemaNames.add(definition.name);
    if (!HANDLED_TOOL_NAMES.has(definition.name)) {
      throw new WorkshopError(
        'internal_error',
        `Workshop tool ${definition.name} has no handler`,
      );
    }
  }
  for (const name of HANDLED_TOOL_NAMES) {
    if (!schemaNames.has(name)) {
      throw new WorkshopError(
        'internal_error',
        `Workshop handler ${name} has no tool definition`,
      );
    }
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkshopError('validation_failed', `${field} is required`, 400, {
      field,
    });
  }
  return value.trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new WorkshopError('query_timeout', 'Tool call timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
