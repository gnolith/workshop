import type { KnowledgeService } from '../protocol/knowledge.js';
import {
  WorkshopError,
  normalizeWorkshopError,
  type WorkshopErrorBody,
} from '../protocol/errors.js';
import { hasWorkshopCapability, type WorkshopPrincipal } from '../protocol.js';
import { authorize } from '../server/authorization.js';
import { KNOWLEDGE_READ_TOOL_NAMES } from '../server/knowledge.js';
import type { WorkshopLimits } from '../server/limits.js';
import { resolveLimits } from '../server/limits.js';
import type { MemoryService } from '../server/memories.js';
import {
  observed,
  observeSafely,
  type ObserveWorkshop,
} from '../server/observability.js';
import type { PacketService } from '../server/packets.js';
import type { TaskService } from '../server/tasks.js';
import type { PromptService } from '../server/prompts.js';
import type { WorkshopSearchIntegrationV1 } from '../server/search.js';
import { workshopTools, type WorkshopToolDefinition } from './tools.js';

/** The transport-neutral services needed to execute Workshop tools. */
export interface WorkshopToolRuntime {
  readonly tasks: TaskService;
  readonly memories: MemoryService;
  readonly prompts?: PromptService;
  readonly search?: WorkshopSearchIntegrationV1;
  readonly packets: PacketService;
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
  'list_prompts',
  'get_prompt',
  'create_prompt',
  'update_prompt',
  'delete_prompt',
  'prompt_history',
  'search',
  'search_status',
  'search_admin',
] as const;

const KNOWLEDGE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  KNOWLEDGE_READ_TOOL_NAMES,
);
const HANDLED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DIRECT_TOOL_NAMES,
  ...KNOWLEDGE_READ_TOOL_NAMES,
]);

export function createWorkshopToolDispatcher(
  runtime: WorkshopToolRuntime,
): WorkshopToolDispatcher {
  assertCompleteRegistry();
  const definitions = new Map(
    workshopTools.map((definition) => [definition.name, definition] as const),
  );
  const availableTools = workshopTools;

  return {
    tools: availableTools,
    listTools(principal) {
      const authorized = authorizeResult(principal, 'read');
      if (!authorized.ok) return authorized;
      return {
        ok: true,
        value: availableTools.filter((tool) =>
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
            principalId: authorized.value.principalId,
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
        if (
          normalized.code === 'unauthenticated' ||
          normalized.code === 'forbidden'
        ) {
          const failure = authorizationFailure(normalized);
          if (!failure.ok)
            await observeAuthorizationFailure(
              runtime,
              failure.failure,
              context,
            );
          return failure;
        }
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
      return runtime.tasks.list(input, principal);
    case 'get_task_packet':
      return runtime.packets.get(text(input.id, 'id'), principal, signal);
    case 'create_task':
      return runtime.tasks.create(input as never, principal);
    case 'update_task': {
      const { id, ...update } = input;
      return runtime.tasks.update(text(id, 'id'), update as never, principal);
    }
    case 'archive_task': {
      const { id, expectedRevision, expectedUpdatedAt } = input;
      return runtime.tasks.archive(
        text(id, 'id'),
        {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        } as never,
        principal,
      );
    }
    case 'claim_task':
      return runtime.tasks.claim(text(input.id, 'id'), principal);
    case 'complete_task':
      return runtime.tasks.complete(
        text(input.id, 'id'),
        input.result,
        principal,
      );
    case 'list_memories':
      return runtime.memories.list(input, principal);
    case 'get_memory':
      return runtime.memories.get(text(input.slug, 'slug'), principal);
    case 'upsert_memory': {
      const { slug, ...memory } = input;
      return runtime.memories.upsert(
        text(slug, 'slug'),
        memory as never,
        principal,
      );
    }
    case 'list_prompts':
      return requiredPrompts(runtime).list(input, principal);
    case 'get_prompt':
      return requiredPrompts(runtime).get(text(input.id, 'id'), principal);
    case 'create_prompt':
      return requiredPrompts(runtime).create(input as never, principal);
    case 'update_prompt': {
      const { id, ...update } = input;
      return requiredPrompts(runtime).update(
        text(id, 'id'),
        update as never,
        principal,
      );
    }
    case 'delete_prompt':
      return requiredPrompts(runtime).delete(
        text(input.id, 'id'),
        positive(input.expectedRevision, 'expectedRevision'),
        principal,
      );
    case 'prompt_history':
      return requiredPrompts(runtime).history(text(input.id, 'id'), principal);
    case 'search':
      return requiredSearch(runtime).search(input as never, principal);
    case 'search_status': {
      const search = requiredSearch(runtime);
      return {
        materialization: await search.materialization.health(principal),
        semantic: await search.semantic.status(principal),
      };
    }
    case 'search_admin':
      return executeSearchAdmin(
        requiredSearch(runtime),
        input,
        principal,
        signal,
      );
  }

  if (KNOWLEDGE_TOOL_NAME_SET.has(name)) {
    return runtime.knowledge.call({ name, input }, { ...principal, requestId });
  }
  throw new WorkshopError('internal_error', `Tool ${name} has no handler`);
}

function requiredPrompts(runtime: WorkshopToolRuntime): PromptService {
  if (!runtime.prompts)
    throw new WorkshopError(
      'internal_error',
      'Prompt producer is not registered',
    );
  return runtime.prompts;
}

function requiredSearch(
  runtime: WorkshopToolRuntime,
): WorkshopSearchIntegrationV1 {
  if (!runtime.search)
    throw new WorkshopError(
      'internal_error',
      'Search integration is not registered',
    );
  return runtime.search;
}

async function executeSearchAdmin(
  search: WorkshopSearchIntegrationV1,
  input: Record<string, unknown>,
  principal: WorkshopPrincipal,
  signal: AbortSignal,
): Promise<unknown> {
  const operation = text(input.operation, 'operation');
  const id = () => text(input.configurationId, 'configurationId');
  const plan = () => text(input.planId, 'planId');
  switch (operation) {
    case 'materialize':
      return search.materialization.run(principal, {
        maxJobs: positive(input.maxJobs ?? 20, 'maxJobs'),
        maxRebuildRoots: positive(
          input.maxRebuildRoots ?? 100,
          'maxRebuildRoots',
        ),
      });
    case 'retry-dead':
      return search.materialization.retryDead(principal, {
        limit: positive(input.limit ?? 20, 'limit'),
      });
    case 'adopt-legacy': {
      const kind = text(input.kind, 'kind');
      if (kind !== 'task' && kind !== 'memory' && kind !== 'prompt')
        throw new WorkshopError('validation_failed', 'kind is invalid');
      return search[kind].producer.adoptLegacyPage(principal, {
        limit: positive(input.limit ?? 100, 'limit'),
      });
    }
    case 'start-rebuild':
      return search.materialization.startShadowRebuild(principal);
    case 'activate-rebuild':
      return search.materialization.activateReadyShadow(principal);
    case 'semantic-select':
      return search.semantic.select(id(), principal);
    case 'semantic-reconnect':
      return search.semantic.reconnect(id(), principal);
    case 'semantic-estimate':
      return search.semantic.estimate(id(), input.policy as never, principal);
    case 'semantic-approve':
      return search.semantic.approve(plan(), principal);
    case 'semantic-run':
      return search.semantic.run(plan(), principal, signal);
    case 'semantic-resume':
      return search.semantic.resume(plan(), principal, signal);
    case 'semantic-pause':
      return search.semantic.pause(plan(), principal);
    case 'semantic-stop':
      return search.semantic.stop(plan(), principal);
    case 'semantic-retry':
      return search.semantic.retry(plan(), principal);
    case 'semantic-exclude':
      return search.semantic.exclude(
        id(),
        positive(input.generation, 'generation'),
        text(input.derivedId, 'derivedId'),
        text(input.reason, 'reason'),
        principal,
      );
    case 'semantic-retire':
      return search.semantic.retire(id(), principal);
    case 'semantic-delete-embeddings':
      return search.semantic.deleteEmbeddings(id(), principal);
    default:
      throw new WorkshopError(
        'validation_failed',
        'search admin operation is invalid',
      );
  }
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
    ...(context.principal
      ? { principalId: context.principal.principalId }
      : {}),
  });
}

function hasCapability(
  principal: WorkshopPrincipal,
  capability: WorkshopToolDefinition['capability'],
): boolean {
  return hasWorkshopCapability(principal.capabilities, capability);
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

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new WorkshopError(
      'validation_failed',
      `${field} must be a positive integer`,
    );
  return Number(value);
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
