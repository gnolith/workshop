import type { TaprootHostWriteCapability } from '@gnolith/taproot';
import {
  canonicalSearchHashV1,
  createAuthorizedSearchServiceV1,
  createSearchMaterializationAdminGuardV1,
  createSemanticSearchAdminV1,
  registerExternalProducerKindV1,
  registerExternalProducerV1,
  type ExternalProducer,
  type ExternalProjectedSearchDocumentV1,
  type ExternalSearchKind,
  type ProducerSource,
  type SearchMaterializationAdminGuardV1,
  type SearchRequest,
  type SearchResultV1,
  type SemanticSearchAdminV1,
} from '@gnolith/taproot/search';
import type { AuthorizationContext } from '../protocol/authorization.js';
import { WorkshopError } from '../protocol/errors.js';
import {
  authorizeRecord,
  normalizeVisibilityScope,
  type VisibilityScopeV1,
} from './authorization.js';
import {
  createWorkshopCanonicalOwnerAdapterV1,
  type WorkshopSearchDomainV1,
} from './canonical-producer.js';
import type { D1DatabaseLike } from './database.js';

export type WorkshopSearchSourceKind = 'task' | 'memory' | 'prompt';

export interface WorkshopSearchIntegrationDomainV1 extends WorkshopSearchDomainV1 {
  /** Compatibility spelling for the pre-0.5 Workshop test/host surface. */
  readonly producer: {
    adoptLegacyPage(
      context: AuthorizationContext,
      input: { cursor?: string | null; limit: number },
    ): Promise<{
      enumerated: number;
      adopted: number;
      cursor: string | null;
      complete: boolean;
    }>;
  };
}

export type WorkshopSearchRequestV1 = Omit<SearchRequest, 'kinds'> & {
  kinds?: readonly (
    | 'statement'
    | 'item'
    | 'task'
    | 'memory'
    | 'prompt'
    | 'resource'
    | 'annotation'
  )[];
};

export type WorkshopSearchKindV1 =
  | 'statement'
  | 'item'
  | 'task'
  | 'memory'
  | 'prompt'
  | 'resource'
  | 'annotation';

export type WorkshopSearchResultV1 = Omit<SearchResultV1, 'kind'> & {
  kind: WorkshopSearchKindV1;
};

export interface WorkshopSearchPageV1 {
  results: WorkshopSearchResultV1[];
  cursor?: string;
}

export interface WorkshopAuthorizedSearchServiceV1 {
  search(
    request: WorkshopSearchRequestV1,
    context: AuthorizationContext,
  ): Promise<WorkshopSearchPageV1>;
  hydrate(
    result: WorkshopSearchResultV1,
    context: AuthorizationContext,
  ): Promise<unknown>;
}

export interface WorkshopSearchIntegrationV1 {
  readonly task: WorkshopSearchIntegrationDomainV1;
  readonly memory: WorkshopSearchIntegrationDomainV1;
  readonly prompt: WorkshopSearchIntegrationDomainV1;
  readonly service: WorkshopAuthorizedSearchServiceV1;
  readonly materialization: SearchMaterializationAdminGuardV1;
  readonly semantic: SemanticSearchAdminV1;
  search(
    request: WorkshopSearchRequestV1,
    context: AuthorizationContext,
  ): Promise<WorkshopSearchPageV1>;
}

export interface CreateWorkshopSearchIntegrationOptionsV1 {
  db: D1DatabaseLike;
  taproot: { baseIri: string; clock?: () => Date };
  hostCapability: TaprootHostWriteCapability;
  installationId: string;
  registrationContext: AuthorizationContext;
  clock?: () => Date;
  createId?: () => string;
}

const SEARCH_NAMESPACE = 'workshop';

export async function createWorkshopSearchIntegrationV1(
  options: CreateWorkshopSearchIntegrationOptionsV1,
): Promise<WorkshopSearchIntegrationV1> {
  const domains = new Map<
    WorkshopSearchSourceKind,
    WorkshopSearchIntegrationDomainV1
  >();
  const domainKinds = new Map<WorkshopSearchSourceKind, ExternalSearchKind>();
  for (const sourceKind of ['task', 'memory', 'prompt'] as const) {
    const controller = createWorkshopCanonicalOwnerAdapterV1(options.db);
    const registeredKind = await registerExternalProducerKindV1(
      options.db,
      { baseIri: options.taproot.baseIri },
      options.hostCapability,
      {
        installationId: options.installationId,
        namespace: SEARCH_NAMESPACE,
        localName: sourceKind,
        ownerDomain: 'workshop',
        adapter: controller.adapter,
      },
    );
    const fingerprint = await canonicalSearchHashV1({
      package: '@gnolith/workshop',
      version: '0.5.0',
      sourceKind,
      projectionVersion: `workshop-${sourceKind}-projection-v1`,
    });
    const producer: ExternalProducer = {
      descriptor: {
        registration: registeredKind.registration,
        implementationVersion: '0.5.0',
        fingerprint,
        projectionVersion: `workshop-${sourceKind}-projection-v1`,
        changeClasses: changeClassesFor(sourceKind),
      },
      async enumerate(cursor, limit) {
        const page = await enumerate(
          options.db,
          options.installationId,
          sourceKind,
          cursor,
          limit,
        );
        return { ids: page.sourceIds, cursor: page.nextCursor };
      },
      async loadExact(sourceId, sourceRevision) {
        const source = await load(
          options.db,
          options.installationId,
          sourceKind,
          sourceId,
          sourceRevision ?? null,
        );
        if (!source)
          throw new WorkshopError(
            'not_found',
            'Canonical source not found',
            404,
          );
        return source;
      },
      project(source) {
        return Promise.resolve(project(sourceKind, source));
      },
      async authorize(reference, context) {
        const source = await load(
          options.db,
          options.installationId,
          sourceKind,
          reference.sourceId,
          reference.sourceRevision,
        );
        if (!source) return false;
        try {
          authorizeSource(source, context);
          return true;
        } catch {
          return false;
        }
      },
      async hydrate(reference, context) {
        const source = await load(
          options.db,
          options.installationId,
          sourceKind,
          reference.sourceId,
          reference.sourceRevision,
        );
        if (!source)
          throw new WorkshopError(
            'not_found',
            'Canonical source not found',
            404,
          );
        authorizeSource(source, context);
        return source.canonical;
      },
    };
    const registered = await registerExternalProducerV1(
      options.db,
      {
        baseIri: options.taproot.baseIri,
        ...(options.clock ? { clock: options.clock } : {}),
      },
      options.hostCapability,
      producer,
    );
    const domain = controller.bind(registered);
    domainKinds.set(sourceKind, registered.kind);
    domains.set(sourceKind, {
      ...domain,
      producer: {
        async adoptLegacyPage(context, input) {
          const receipt = await domain.adopt(context, input);
          return { ...receipt, complete: receipt.cursor === null };
        },
      },
    });
  }

  const semantic = createSemanticSearchAdminV1(options.db, {
    installationId: options.installationId,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
  });
  const rawService = createAuthorizedSearchServiceV1(options.db, {
    installationId: options.installationId,
    semantic,
  });
  const materialization = await createSearchMaterializationAdminGuardV1(
    options.db,
    {
      baseIri: options.taproot.baseIri,
      ...(options.clock ? { clock: options.clock } : {}),
    },
    options.hostCapability,
  );
  await materialization.initialize(options.registrationContext);
  const toTaprootRequest = ({
    kinds,
    ...request
  }: WorkshopSearchRequestV1): SearchRequest => ({
    ...request,
    ...(kinds
      ? {
          kinds: kinds.map((kind) =>
            kind === 'task' || kind === 'memory' || kind === 'prompt'
              ? requiredDomainKind(domainKinds, kind)
              : kind,
          ),
        }
      : {}),
  });
  const service: WorkshopAuthorizedSearchServiceV1 = {
    async search(request, context) {
      const page = await rawService.search(toTaprootRequest(request), context);
      return {
        ...page,
        results: page.results.map((result) => ({
          ...result,
          kind:
            typeof result.kind === 'string'
              ? result.kind
              : (result.kind.localName as WorkshopSearchKindV1),
        })),
      };
    },
    hydrate(result, context) {
      const kind =
        result.kind === 'task' ||
        result.kind === 'memory' ||
        result.kind === 'prompt'
          ? requiredDomainKind(domainKinds, result.kind)
          : result.kind;
      return rawService.hydrate({ ...result, kind } as SearchResultV1, context);
    },
  };
  return {
    task: requiredDomain(domains, 'task'),
    memory: requiredDomain(domains, 'memory'),
    prompt: requiredDomain(domains, 'prompt'),
    service,
    semantic,
    materialization,
    search: (request, context) => service.search(request, context),
  };
}

async function enumerate(
  db: D1DatabaseLike,
  installationId: string,
  kind: WorkshopSearchSourceKind,
  cursor: string | null,
  limit: number,
): Promise<{ sourceIds: readonly string[]; nextCursor: string | null }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new WorkshopError(
      'validation_failed',
      'Search page limit is invalid',
    );
  const table = tableFor(kind);
  const id = idColumnFor(kind);
  const live = kind === 'task' ? '1 = 1' : 'deleted_at IS NULL';
  const rows = await db
    .prepare(
      `SELECT ${id} AS id FROM ${table}
       WHERE installation_id = ? AND ${id} > ? AND ${live}
         AND visibility_scope IS NOT NULL AND authorization_revision IS NOT NULL
       ORDER BY ${id} ASC LIMIT ?`,
    )
    .bind(installationId, cursor ?? '', limit + 1)
    .all<{ id: string }>();
  const visible = rows.results.slice(0, limit);
  return {
    sourceIds: visible.map(({ id: sourceId }) => sourceId),
    nextCursor:
      rows.results.length > limit ? (visible.at(-1)?.id ?? null) : null,
  };
}

async function load(
  db: D1DatabaseLike,
  installationId: string,
  kind: WorkshopSearchSourceKind,
  sourceId: string,
  expectedRevision: string | null,
): Promise<ProducerSource | null> {
  const table = tableFor(kind);
  const id = idColumnFor(kind);
  const live = kind === 'task' ? '1 = 1' : 'deleted_at IS NULL';
  const row = await db
    .prepare(
      `SELECT * FROM ${table}
       WHERE installation_id = ? AND ${id} = ? AND ${live}`,
    )
    .bind(installationId, sourceId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const revision = integer(row.revision);
  if (expectedRevision !== null && expectedRevision !== String(revision))
    return null;
  return {
    sourceId,
    sourceRevision: String(revision),
    sourcePolicyRevision: integer(row.policy_revision),
    canonical: canonicalRecord(kind, row),
  };
}

function project(
  kind: WorkshopSearchSourceKind,
  source: ProducerSource,
): ExternalProjectedSearchDocumentV1 {
  const canonical = record(source.canonical);
  const fields =
    kind === 'task'
      ? ['title', 'objective', 'description', 'prompt', 'result']
      : kind === 'memory'
        ? ['title', 'description', 'content']
        : ['name', 'title', 'promptText', 'scope', 'role'];
  const text = fields
    .map((field) => canonical[field])
    .filter((value): value is string => typeof value === 'string' && !!value)
    .join(' ')
    // Taproot external projections are tokens: authored line breaks and other
    // control characters must not cross the producer boundary.
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text)
    throw new WorkshopError('validation_failed', 'Source is not searchable');
  return {
    text,
    ...(typeof canonical.title === 'string'
      ? { title: canonical.title }
      : typeof canonical.name === 'string'
        ? { title: canonical.name }
        : {}),
    ...(typeof canonical.language === 'string'
      ? { language: canonical.language }
      : {}),
  };
}

function authorizeSource(
  source: ProducerSource,
  context: AuthorizationContext,
): void {
  const canonical = record(source.canonical);
  authorizeRecord(
    {
      installationId: string(canonical.installationId),
      visibility: normalizeVisibilityScope(
        canonical.visibility as VisibilityScopeV1,
      ),
      authorizationRevision: integer(canonical.authorizationRevision),
    },
    context,
  );
}

function requiredDomainKind(
  domains: Map<WorkshopSearchSourceKind, ExternalSearchKind>,
  kind: WorkshopSearchSourceKind,
): ExternalSearchKind {
  const domain = requiredDomain(domains, kind);
  return domain;
}

function canonicalRecord(
  kind: WorkshopSearchSourceKind,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const common = {
    installationId: row.installation_id,
    ownerPrincipalId: row.owner_principal_id,
    workspaceId: row.workspace_id,
    visibility: json(row.visibility_scope),
    authorizationRevision: row.authorization_revision,
    revision: row.revision,
    policyRevision: row.policy_revision,
    language: row.language,
  };
  if (kind === 'task')
    return {
      ...common,
      id: row.id,
      title: row.title,
      objective: row.objective,
      description: row.description,
      prompt: row.prompt,
      result: row.result,
    };
  if (kind === 'memory')
    return {
      ...common,
      slug: row.slug,
      title: row.title,
      description: row.description,
      content: row.content,
    };
  return {
    ...common,
    id: row.id,
    name: row.name,
    title: row.title,
    promptText: row.prompt_text,
    scope: row.scope,
    role: row.role,
  };
}

function requiredDomain<T>(
  domains: Map<WorkshopSearchSourceKind, T>,
  kind: WorkshopSearchSourceKind,
): T {
  const domain = domains.get(kind);
  if (!domain) throw new Error(`Missing Workshop ${kind} search domain`);
  return domain;
}

function tableFor(kind: WorkshopSearchSourceKind): string {
  return kind === 'task'
    ? 'workshop_tasks'
    : kind === 'memory'
      ? 'workshop_memories'
      : 'workshop_prompts';
}

function idColumnFor(kind: WorkshopSearchSourceKind): string {
  return kind === 'memory' ? 'slug' : 'id';
}

function changeClassesFor(kind: WorkshopSearchSourceKind): readonly string[] {
  return [
    `${kind}.create`,
    `${kind}.update`,
    `${kind}.state`,
    `${kind}.policy`,
    `${kind}.delete`,
    `${kind}.backfill`,
  ];
}

function integer(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new WorkshopError('internal_error', 'Invalid canonical integer');
  return number;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new WorkshopError('internal_error', 'Invalid canonical string');
  return value;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string')
    throw new WorkshopError('internal_error', 'Invalid canonical JSON');
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkshopError('internal_error', 'Invalid canonical JSON');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkshopError('internal_error', 'Invalid canonical record');
  return value as Record<string, unknown>;
}
