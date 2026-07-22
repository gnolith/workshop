import { WorkshopError } from '../protocol/errors.js';
import type {
  KnowledgeService,
  KnowledgeToolCall,
} from '../protocol/knowledge.js';
import type { ObserveWorkshop } from './observability.js';
import {
  requireCapability,
  requireCurrentAuthorization,
  denied,
  type AuthorizationContext,
  type WorkshopAuthorizationSource,
} from './authorization.js';
import { observed } from './observability.js';
import type {
  TaprootEntityId,
  TaprootAuthorizedReaderLike,
} from './taproot-contract.js';

export type {
  TaprootAuthorizedReaderLike,
  TaprootCanonicalAuthorizationPolicyInput,
  TaprootKnowledgeWriter,
  TaprootMutationReceipt,
  TaprootStatement,
} from './taproot-contract.js';

export const KNOWLEDGE_TOOL_NAMES = [
  'search_entities',
  'get_entity',
  'get_entities',
  'create_item',
  'create_property',
  'set_label',
  'set_description',
  'add_alias',
  'remove_alias',
  'add_sitelink',
  'remove_sitelink',
  'add_statement',
  'replace_statement',
  'remove_statement',
  'set_statement_rank',
  'add_qualifier',
  'remove_qualifier',
  'add_reference',
  'remove_reference',
  'export_entity_json',
] as const;

export const KNOWLEDGE_READ_TOOL_NAMES = [
  'search_entities',
  'get_entity',
  'get_entities',
  'export_entity_json',
] as const satisfies readonly (typeof KNOWLEDGE_TOOL_NAMES)[number][];

export const KNOWLEDGE_MUTATION_TOOL_NAMES = KNOWLEDGE_TOOL_NAMES.filter(
  (name) => !(KNOWLEDGE_READ_TOOL_NAMES as readonly string[]).includes(name),
);

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

export interface TaprootKnowledgeOptions {
  observe?: ObserveWorkshop;
  authorization: WorkshopAuthorizationSource;
  authorizedReader: (
    context: AuthorizationContext,
    source: WorkshopAuthorizationSource,
  ) => TaprootAuthorizedReaderLike;
  health: () => boolean | Promise<boolean>;
}

export function createTaprootKnowledgeService(
  options: TaprootKnowledgeOptions,
): KnowledgeService {
  return {
    async call(call, context) {
      const rawAuthorization: AuthorizationContext = {
        installationId: context.installationId,
        principalId: context.principalId,
        activeWorkspaceId: context.activeWorkspaceId,
        workspaceIds: context.workspaceIds,
        capabilities: context.capabilities,
        authorizationRevision: context.authorizationRevision,
      };
      const authorization = await requireCurrentAuthorization(
        options.authorization,
        rawAuthorization,
      );
      if (
        (KNOWLEDGE_MUTATION_TOOL_NAMES as readonly string[]).includes(call.name)
      )
        throw denied();
      requireCapability(authorization, 'read');
      return observed(
        options.observe,
        {
          operation: 'knowledge.call',
          principalId: context.principalId,
          ...(context.requestId ? { requestId: context.requestId } : {}),
        },
        () =>
          invoke(
            call,
            options.authorizedReader(authorization, options.authorization),
          ),
      );
    },
    async health() {
      try {
        return await options.health();
      } catch {
        return false;
      }
    },
  };
}

async function invoke(
  call: KnowledgeToolCall,
  authorizedReader: TaprootAuthorizedReaderLike,
): Promise<unknown> {
  if (!KNOWLEDGE_TOOL_NAMES.includes(call.name as KnowledgeToolName)) {
    throw new WorkshopError('not_found', `Unknown knowledge tool ${call.name}`);
  }
  const input = call.input;
  const id = () => entityId(input.entityId, 'entityId');

  switch (call.name as KnowledgeToolName) {
    case 'search_entities':
      return authorizedReader.searchEntities(text(input.query, 'query'), {
        ...(typeof input.language === 'string'
          ? { language: input.language }
          : {}),
        ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      });
    case 'get_entity':
      return authorizedReader.getEntity(id());
    case 'get_entities': {
      if (!Array.isArray(input.entityIds) || input.entityIds.length > 100) {
        throw invalid('entityIds must be an array with at most 100 entries');
      }
      return Promise.all(
        input.entityIds.map((entityId) =>
          authorizedReader.getEntity(entityIdValue(entityId, 'entityIds[]')),
        ),
      );
    }
    case 'create_item':
    case 'create_property':
    case 'set_label':
    case 'set_description':
    case 'add_alias':
    case 'remove_alias':
    case 'add_sitelink':
    case 'remove_sitelink':
    case 'add_statement':
    case 'replace_statement':
    case 'remove_statement':
    case 'set_statement_rank':
    case 'add_qualifier':
    case 'remove_qualifier':
    case 'add_reference':
    case 'remove_reference':
      throw denied();
    case 'export_entity_json': {
      const stored = await authorizedReader.getEntity(id());
      return JSON.stringify(
        (stored as { entity?: unknown }).entity ?? stored,
        null,
        2,
      );
    }
  }
}

function entityId(value: unknown, field: string): TaprootEntityId {
  return entityIdValue(value, field);
}

function entityIdValue(value: unknown, field: string): TaprootEntityId {
  const candidate = text(value, field);
  if (!/^[QP]\d+$/u.test(candidate)) {
    throw invalid(`${field} must be a Q or P entity ID`, field);
  }
  return candidate as TaprootEntityId;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} is required`, field);
  }
  return value.trim();
}

function invalid(message: string, field?: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400, {
    ...(field ? { field } : {}),
  });
}
