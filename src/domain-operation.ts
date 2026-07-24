import type { OperationName } from './generated/operations.js';
import type {
  OperationCallContext,
  WorkshopDomainOperationPort,
} from './operations.js';
import type {
  MemoryFilters,
  PromptFilters,
  TaskFilters,
  UpdateTaskInput,
} from './protocol.js';
import { WorkshopError } from './protocol/errors.js';
import type { AuthorizationContext } from './server/authorization.js';
import type { WorkshopCore } from './server/context.js';

const WORKSHOP_OPERATION_NAMES = new Set<OperationName>([
  'list_tasks',
  'search_tasks',
  'get_task',
  'get_task_packet',
  'create_task',
  'update_task',
  'archive_task',
  'claim_task',
  'release_task',
  'complete_task',
  'task_history',
  'list_memories',
  'get_memory',
  'upsert_memory',
  'delete_memory',
  'memory_history',
  'list_prompts',
  'get_prompt',
  'create_prompt',
  'update_prompt',
  'delete_prompt',
  'prompt_history',
]);

/**
 * Binds Workshop's public operation contract to its owner services. The
 * caller must pass a principal that has already crossed Taproot's live
 * authorization fence.
 */
export function createWorkshopDomainOperationPortV1(
  core: WorkshopCore,
): WorkshopDomainOperationPort {
  if (!core.prompts)
    throw new WorkshopError(
      'internal_error',
      'Workshop prompt operations are not configured',
      500,
    );
  const prompts = core.prompts;
  return Object.freeze({
    async call(
      name: OperationName,
      input: Readonly<Record<string, unknown>>,
      context: OperationCallContext,
    ): Promise<unknown> {
      if (!WORKSHOP_OPERATION_NAMES.has(name))
        throw new WorkshopError('not_found', 'Operation not found', 404);
      const authorization = liveAuthorization(context);
      switch (name) {
        case 'list_tasks':
          return core.tasks.list(taskFilters(input), authorization);
        case 'search_tasks':
          return core.tasks.search(taskFilters(input), authorization);
        case 'get_task':
          return core.tasks.get(String(input.taskId), authorization);
        case 'get_task_packet':
          return core.packets.get(
            String(input.taskId),
            authorization,
            context.signal,
          );
        case 'create_task':
          return core.tasks.create(
            {
              ...record(input.data),
              idempotencyKey: String(input.idempotencyKey),
              description: String(input.description),
              prompt: String(input.prompt),
            },
            authorization,
          );
        case 'update_task': {
          const update = {
            ...record(input.patch),
            expectedRevision: Number(input.expectedRevision),
          } as unknown as UpdateTaskInput;
          return input.leaseToken === undefined
            ? core.tasks.update(String(input.taskId), update, authorization)
            : core.tasks.updateWithLease(
                String(input.taskId),
                update,
                input.leaseToken,
                authorization,
              );
        }
        case 'archive_task':
          return core.tasks.archive(
            String(input.taskId),
            {
              expectedRevision: Number(input.expectedRevision),
              ...(input.leaseToken === undefined
                ? {}
                : { leaseToken: input.leaseToken }),
            },
            authorization,
          );
        case 'claim_task':
          return core.tasks.claimLease(
            input.taskId,
            input.leaseSeconds,
            authorization,
          );
        case 'release_task':
          return core.tasks.releaseLease(
            {
              taskId: input.taskId,
              leaseToken: input.leaseToken,
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
            },
            authorization,
          );
        case 'complete_task':
          return core.tasks.completeLease(
            {
              taskId: input.taskId,
              leaseToken: input.leaseToken,
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
              result: input.result,
              outcomeKind: input.outcomeKind,
            },
            authorization,
          );
        case 'task_history':
          return core.tasks
            .history(String(input.taskId), authorization, {
              ...(input.limit === undefined
                ? {}
                : { limit: Number(input.limit) }),
            })
            .then((items) => ({ items }));
        case 'list_memories':
          return core.memories.list(memoryFilters(input), authorization);
        case 'get_memory':
          return core.memories.get(String(input.slug), authorization);
        case 'upsert_memory':
          return core.memories.putIdempotent(
            String(input.slug),
            {
              ...record(input.data),
              ...(input.expectedRevision === undefined
                ? {}
                : { expectedRevision: Number(input.expectedRevision) }),
              description: String(input.description),
              content: String(input.content),
            },
            authorization,
            String(input.idempotencyKey),
          );
        case 'delete_memory':
          await core.memories.delete(
            String(input.slug),
            Number(input.expectedRevision),
            authorization,
            String(input.idempotencyKey),
          );
          return { deleted: true, slug: String(input.slug) };
        case 'memory_history':
          return core.memories
            .history(String(input.slug), authorization, {
              ...(input.limit === undefined
                ? {}
                : { limit: Number(input.limit) }),
            })
            .then((items) => ({ items }));
        case 'list_prompts':
          return prompts.list(promptFilters(input), authorization);
        case 'get_prompt':
          return prompts.get(String(input.promptId), authorization);
        case 'create_prompt':
          return prompts.create(
            {
              ...record(input.data),
              name: String(input.name),
              promptText: String(input.promptText),
            },
            authorization,
            String(input.idempotencyKey),
          );
        case 'update_prompt':
          return prompts.update(
            String(input.promptId),
            {
              ...record(input.patch),
              expectedRevision: Number(input.expectedRevision),
            },
            authorization,
            String(input.idempotencyKey),
          );
        case 'delete_prompt':
          await prompts.delete(
            String(input.promptId),
            Number(input.expectedRevision),
            authorization,
            String(input.idempotencyKey),
          );
          return { deleted: true, promptId: String(input.promptId) };
        case 'prompt_history':
          return prompts
            .history(String(input.promptId), authorization, {
              ...(input.limit === undefined
                ? {}
                : { limit: Number(input.limit) }),
            })
            .then((items) => ({ items }));
        default:
          throw new WorkshopError('not_found', 'Operation not found', 404);
      }
    },
  });
}

function liveAuthorization(
  context: OperationCallContext,
): AuthorizationContext {
  const { principal } = context;
  if (!Array.isArray(principal.workspaceIds))
    throw new WorkshopError(
      'internal_error',
      'Live authorization context is unavailable',
      500,
    );
  return {
    installationId: principal.installationId,
    principalId: principal.principalId,
    activeWorkspaceId: principal.activeWorkspaceId,
    workspaceIds: principal.workspaceIds,
    capabilities: principal.capabilities,
    authorizationRevision: principal.authorizationRevision,
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function taskFilters(input: Readonly<Record<string, unknown>>): TaskFilters {
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
    ...(input.state === undefined
      ? {}
      : { state: input.state as NonNullable<TaskFilters['state']> }),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
  };
}

function memoryFilters(
  input: Readonly<Record<string, unknown>>,
): MemoryFilters {
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
  };
}

function promptFilters(
  input: Readonly<Record<string, unknown>>,
): PromptFilters {
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
  };
}
