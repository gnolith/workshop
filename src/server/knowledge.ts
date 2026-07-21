import { WorkshopError } from '../protocol/errors.js';
import type {
  KnowledgeService,
  KnowledgeToolCall,
} from '../protocol/knowledge.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';
import type {
  TaprootCreatePropertyInput,
  TaprootEntityId,
  TaprootRepositoryLike,
  TaprootReference,
  TaprootSitelink,
  TaprootSnak,
  TaprootStatement,
} from './taproot-contract.js';

export type {
  TaprootRepositoryLike,
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

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

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
      kind: 'agent' as const,
      tool: '@gnolith/workshop',
    },
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
  const edit = () => ({
    expectedRevision: integer(input.expectedRevision, 'expectedRevision'),
    ...metadata,
  });
  const id = () => entityId(input.entityId, 'entityId');

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
          repository.getEntity(entityIdValue(entityId, 'entityIds[]')),
        ),
      );
    }
    case 'create_item':
      validateInitialClaims(input.claims);
      return repository.createItem({
        ...input,
        ...metadata,
      });
    case 'create_property':
      return repository.createProperty({
        ...input,
        ...metadata,
      } as unknown as TaprootCreatePropertyInput);
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
        itemId(input.entityId, 'entityId'),
        text(input.site, 'site'),
        object(input.sitelink, 'sitelink') as unknown as TaprootSitelink,
        edit(),
      );
    case 'remove_sitelink':
      return repository.removeSitelink(
        itemId(input.entityId, 'entityId'),
        text(input.site, 'site'),
        edit(),
      );
    case 'add_statement': {
      const statement = authoredStatement(input.statement, 'statement');
      return annotateStatements(
        repository.addStatement(id(), statement, edit()),
        statementId(statement),
      );
    }
    case 'replace_statement': {
      const statement = authoredStatement(input.statement, 'statement');
      return annotateStatements(
        repository.replaceStatement(
          id(),
          text(input.statementId, 'statementId'),
          statement,
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    }
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
          statementRank(input.rank),
          authoredText(input.text, 'text'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'add_qualifier':
      return annotateStatements(
        repository.addQualifier(
          id(),
          text(input.statementId, 'statementId'),
          object(input.snak, 'snak') as unknown as TaprootSnak,
          authoredText(input.text, 'text'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'remove_qualifier':
      return annotateStatements(
        repository.removeQualifier(
          id(),
          text(input.statementId, 'statementId'),
          propertyId(input.property, 'property'),
          integer(input.ordinal, 'ordinal'),
          authoredText(input.text, 'text'),
          edit(),
        ),
        text(input.statementId, 'statementId'),
      );
    case 'add_reference':
      return annotateStatements(
        repository.addReference(
          id(),
          text(input.statementId, 'statementId'),
          object(input.reference, 'reference') as unknown as TaprootReference,
          authoredText(input.text, 'text'),
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
          authoredText(input.text, 'text'),
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

function itemId(value: unknown, field: string): `Q${number}` {
  const candidate = text(value, field);
  if (!/^Q\d+$/u.test(candidate)) {
    throw invalid(`${field} must be a Q item ID`, field);
  }
  return candidate as `Q${number}`;
}

function propertyId(value: unknown, field: string): `P${number}` {
  const candidate = text(value, field);
  if (!/^P\d+$/u.test(candidate)) {
    throw invalid(`${field} must be a P property ID`, field);
  }
  return candidate as `P${number}`;
}

function statementRank(value: unknown): 'preferred' | 'normal' | 'deprecated' {
  if (value !== 'preferred' && value !== 'normal' && value !== 'deprecated') {
    throw invalid('rank must be preferred, normal, or deprecated', 'rank');
  }
  return value;
}

function authoredStatement(value: unknown, field: string): TaprootStatement {
  const statement = object(value, field);
  authoredText(statement.text, `${field}.text`);
  return statement as unknown as TaprootStatement;
}

function validateInitialClaims(value: unknown): void {
  if (value === undefined) return;
  const claims = object(value, 'claims');
  for (const [property, statements] of Object.entries(claims)) {
    if (!Array.isArray(statements)) {
      throw invalid(
        `claims.${property} must be an array`,
        `claims.${property}`,
      );
    }
    statements.forEach((statement, index) =>
      authoredStatement(statement, `claims.${property}[${index}]`),
    );
  }
}

function authoredText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.replace(/[\p{White_Space}\p{Cf}]/gu, '')
  ) {
    throw invalid(`${field} is required`, field);
  }
  return value;
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
