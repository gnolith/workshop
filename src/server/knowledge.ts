import { WorkshopError } from '../protocol/errors.js';
import type {
  KnowledgeService,
  KnowledgeToolCall,
} from '../protocol/knowledge.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';

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

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

type AnyFunction = (...args: unknown[]) => Promise<unknown>;

export interface TaprootRepositoryLike {
  searchEntitiesPage: AnyFunction;
  getEntity: AnyFunction;
  createItem: AnyFunction;
  createProperty: AnyFunction;
  setLabel: AnyFunction;
  setDescription: AnyFunction;
  addAlias: AnyFunction;
  removeAlias: AnyFunction;
  setSitelink: AnyFunction;
  removeSitelink: AnyFunction;
  addStatement: AnyFunction;
  replaceStatement: AnyFunction;
  removeStatement: AnyFunction;
  setStatementRank: AnyFunction;
  addQualifier: AnyFunction;
  removeQualifier: AnyFunction;
  addReference: AnyFunction;
  removeReference: AnyFunction;
}

export interface TaprootKnowledgeOptions {
  observe?: ObserveWorkshop;
}

export function createTaprootKnowledgeService(
  repository: TaprootRepositoryLike,
  options: TaprootKnowledgeOptions = {},
): KnowledgeService {
  return {
    async call(call, context) {
      return observed(
        options.observe,
        {
          operation: 'knowledge.call',
          principalId: context.principalId,
          ...(context.requestId ? { requestId: context.requestId } : {}),
        },
        () => invoke(repository, call, context),
      );
    },
    async health() {
      try {
        await repository.searchEntitiesPage('', { limit: 1 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function invoke(
  repository: TaprootRepositoryLike,
  call: KnowledgeToolCall,
  context: { principalId: string; requestId?: string },
): Promise<unknown> {
  if (!KNOWLEDGE_TOOL_NAMES.includes(call.name as KnowledgeToolName)) {
    throw new WorkshopError('not_found', `Unknown knowledge tool ${call.name}`);
  }
  const input = call.input;
  const metadata = {
    attribution: {
      id: context.principalId,
      kind: 'agent',
      tool: '@gnolith/workshop',
    },
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
  const edit = () => ({
    expectedRevision: integer(input.expectedRevision, 'expectedRevision'),
    ...metadata,
  });
  const id = () => text(input.entityId, 'entityId');

  switch (call.name as KnowledgeToolName) {
    case 'search_entities':
      return repository.searchEntitiesPage(text(input.query, 'query'), {
        ...(typeof input.language === 'string'
          ? { language: input.language }
          : {}),
        ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      });
    case 'get_entity':
      return repository.getEntity(id());
    case 'get_entities': {
      if (!Array.isArray(input.entityIds) || input.entityIds.length > 100) {
        throw invalid('entityIds must be an array with at most 100 entries');
      }
      return Promise.all(
        input.entityIds.map((entityId) =>
          repository.getEntity(text(entityId, 'entityIds[]') as never),
        ),
      );
    }
    case 'create_item':
      return repository.createItem({ ...input, ...metadata });
    case 'create_property':
      return repository.createProperty({ ...input, ...metadata });
    case 'set_label':
      return repository.setLabel(
        id(),
        text(input.language, 'language'),
        text(input.value, 'value'),
        edit(),
      );
    case 'set_description':
      return repository.setDescription(
        id(),
        text(input.language, 'language'),
        text(input.value, 'value'),
        edit(),
      );
    case 'add_alias':
      return repository.addAlias(
        id(),
        text(input.language, 'language'),
        text(input.value, 'value'),
        edit(),
      );
    case 'remove_alias':
      return repository.removeAlias(
        id(),
        text(input.language, 'language'),
        integer(input.ordinal, 'ordinal'),
        edit(),
      );
    case 'add_sitelink':
      return repository.setSitelink(
        id(),
        text(input.site, 'site'),
        object(input.sitelink, 'sitelink'),
        edit(),
      );
    case 'remove_sitelink':
      return repository.removeSitelink(id(), text(input.site, 'site'), edit());
    case 'add_statement':
      return annotateStatements(
        repository.addStatement(
          id(),
          object(input.statement, 'statement'),
          edit(),
        ),
        statementId(input.statement),
      );
    case 'replace_statement':
      return annotateStatements(
        repository.replaceStatement(
          id(),
          text(input.statementId, 'statementId'),
          object(input.statement, 'statement'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'remove_statement':
      return annotateStatements(
        repository.removeStatement(
          id(),
          text(input.statementId, 'statementId'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'set_statement_rank':
      return annotateStatements(
        repository.setStatementRank(
          id(),
          text(input.statementId, 'statementId'),
          text(input.rank, 'rank'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'add_qualifier':
      return annotateStatements(
        repository.addQualifier(
          id(),
          text(input.statementId, 'statementId'),
          object(input.snak, 'snak'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'remove_qualifier':
      return annotateStatements(
        repository.removeQualifier(
          id(),
          text(input.statementId, 'statementId'),
          text(input.property, 'property'),
          integer(input.ordinal, 'ordinal'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'add_reference':
      return annotateStatements(
        repository.addReference(
          id(),
          text(input.statementId, 'statementId'),
          object(input.reference, 'reference'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'remove_reference':
      return annotateStatements(
        repository.removeReference(
          id(),
          text(input.statementId, 'statementId'),
          text(input.hash, 'hash'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'export_entity_json': {
      const stored = await repository.getEntity(id());
      return JSON.stringify(
        (stored as { entity?: unknown }).entity ?? stored,
        null,
        2,
      );
    }
  }
}

function statementId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

async function annotateStatements(
  pending: Promise<unknown>,
  changedStatementId?: string,
): Promise<unknown> {
  const result = await pending;
  if (!changedStatementId) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, changedStatementIds: [changedStatementId] };
  }
  const record = result as Record<string, unknown>;
  return {
    ...record,
    changedStatementIds: Array.isArray(record.changedStatementIds)
      ? record.changedStatementIds
      : [changedStatementId],
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} is required`, field);
  }
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`, field);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string, field?: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400, {
    ...(field ? { field } : {}),
  });
}
