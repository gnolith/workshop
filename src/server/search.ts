import type {
  AuthorizedSearchServiceV1,
  ExternalSearchDomainMutationCoordinatorV1,
  ExternalSearchLoadedSourceV1,
  ExternalSearchProducerCallbacksV1,
  ExternalSearchProducerDescriptorV1,
  ExternalSearchProducerGuardV1,
  SearchMaterializationAdminGuardV1,
  SearchProjectionFieldV1,
  SearchProjectionSegmentV1,
  SearchRequest,
  SearchPage,
  SemanticSearchAdminV1,
  TaprootHostWriteCapability,
  TaprootWriteOptions,
  UnifiedSearchFiltersV1,
  UnifiedSearchReferenceV1,
} from '@gnolith/taproot';
import type { AuthorizationContext } from '../protocol/authorization.js';
import { WorkshopError } from '../protocol/errors.js';
import type { D1DatabaseLike, D1ResultLike } from './database.js';
import {
  normalizeVisibilityScope,
  serializeVisibilityScope,
  type VisibilityScopeV1,
} from './authorization.js';

export type WorkshopSearchSourceKind = 'task' | 'memory' | 'prompt';

export interface WorkshopSearchDomainV1 {
  readonly coordinator: ExternalSearchDomainMutationCoordinatorV1;
  readonly producer: ExternalSearchProducerGuardV1;
  readonly descriptor: Readonly<ExternalSearchProducerDescriptorV1>;
}

interface ExternalAuthorization {
  version: 1;
  sourceId: string;
  sourceRevision: string;
  sourcePolicyRevision: number;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
}

export interface WorkshopCanonicalSearchMutationV1 {
  context: AuthorizationContext;
  eventId: string;
  sourceId: string;
  operation: 'upsert' | 'delete';
  changeClass: string;
  sourceRevision: number;
  sourcePolicyRevision: number;
  predecessor: { eventId: string; sequence: number } | null;
  canonicalPostState: unknown;
  statements: readonly { sql: string; values: readonly unknown[] }[];
}

export interface WorkshopCanonicalSearchMutationReceiptV1 {
  eventId: string;
  authorizationRevision: number;
  searchGeneration: number;
  results: readonly D1ResultLike[];
}

export async function commitWorkshopCanonicalSearchMutationV1(
  domain: WorkshopSearchDomainV1,
  input: WorkshopCanonicalSearchMutationV1,
): Promise<WorkshopCanonicalSearchMutationReceiptV1> {
  const sealed = await domain.coordinator.sealCanonicalMutation({
    ...input,
    context: input.context,
    sourceRevision: String(input.sourceRevision),
  });
  const receipt = await domain.producer.commitCanonicalMutation(sealed);
  return receipt;
}

export interface WorkshopSearchIntegrationV1 {
  readonly task: WorkshopSearchDomainV1;
  readonly memory: WorkshopSearchDomainV1;
  readonly prompt: WorkshopSearchDomainV1;
  readonly service: AuthorizedSearchServiceV1;
  readonly materialization: SearchMaterializationAdminGuardV1;
  readonly semantic: SemanticSearchAdminV1;
  search(
    request: SearchRequest,
    context: AuthorizationContext,
  ): Promise<SearchPage>;
}

export interface CreateWorkshopSearchIntegrationOptionsV1 {
  db: D1DatabaseLike;
  taproot: TaprootWriteOptions;
  hostCapability: TaprootHostWriteCapability;
  installationId: string;
  registrationContext: AuthorizationContext;
  clock?: () => Date;
  createId?: () => string;
}

const CONTRACT_VERSION = 'taproot-external-search-producer-v1';
const AUTHORIZATION_VERSION = 'workshop-cnf-policy-v1';

export async function createWorkshopSearchIntegrationV1(
  options: CreateWorkshopSearchIntegrationOptionsV1,
): Promise<WorkshopSearchIntegrationV1> {
  const {
    canonicalSearchHashV1,
    createAuthorizedSearchServiceV1,
    createExternalSearchDomainMutationCoordinatorV1,
    createExternalSearchDomainPolicyAuthorityV1,
    createExternalSearchProducerGuardV1,
    createSearchMaterializationAdminGuardV1,
    createSemanticSearchAdminV1,
  } = await import('@gnolith/taproot');
  const db = options.db;
  const materialization = await createSearchMaterializationAdminGuardV1(
    db,
    options.taproot,
    options.hostCapability,
  );
  await materialization.initialize(options.registrationContext);
  const domains: Array<
    readonly [WorkshopSearchSourceKind, WorkshopSearchDomainV1]
  > = [];
  for (const sourceKind of ['task', 'memory', 'prompt'] as const) {
    const binding = {
      domain: 'workshop',
      sourceKind,
      capability: capabilityFor(sourceKind),
      changeClasses: changeClassesFor(sourceKind),
    } as const;
    const coordinator = await createExternalSearchDomainMutationCoordinatorV1(
      db,
      options.taproot,
      options.hostCapability,
      binding,
    );
    const authority = await createExternalSearchDomainPolicyAuthorityV1(
      db,
      options.taproot,
      options.hostCapability,
      binding,
    );
    const descriptor: ExternalSearchProducerDescriptorV1 = {
      version: 1,
      sourceKind,
      owningDomain: 'workshop',
      producerFingerprint: await canonicalSearchHashV1({
        package: '@gnolith/workshop',
        sourceKind,
        contractVersion: CONTRACT_VERSION,
        projectionVersion: `workshop-${sourceKind}-projection-v1`,
        authorizationContractVersion: AUTHORIZATION_VERSION,
      }),
      contractVersion: CONTRACT_VERSION,
      projectionVersion: `workshop-${sourceKind}-projection-v1`,
      authorizationContractVersion: AUTHORIZATION_VERSION,
    };
    const callbacks = callbacksFor(
      options.db,
      options.installationId,
      sourceKind,
    );
    const producer = await createExternalSearchProducerGuardV1(
      db,
      options.taproot,
      options.hostCapability,
      descriptor,
      callbacks,
      authority,
      coordinator,
    );
    domains.push([sourceKind, { coordinator, producer, descriptor }]);
  }
  const byKind = Object.fromEntries(domains) as Record<
    WorkshopSearchSourceKind,
    WorkshopSearchDomainV1
  >;
  const semantic = createSemanticSearchAdminV1(db, {
    installationId: options.installationId,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
  });
  const service = createAuthorizedSearchServiceV1(db, {
    installationId: options.installationId,
    semantic,
  });
  return {
    task: byKind.task,
    memory: byKind.memory,
    prompt: byKind.prompt,
    service,
    semantic,
    materialization,
    search: (request, context) => service.search(request, context),
  };
}

function callbacksFor(
  db: D1DatabaseLike,
  installationId: string,
  kind: WorkshopSearchSourceKind,
): ExternalSearchProducerCallbacksV1 {
  return {
    enumerateLegacyCurrent: ({ cursor, limit }) =>
      enumerate(db, installationId, kind, cursor, limit),
    loadCurrent: ({ sourceId, expectedSourceRevision }) =>
      load(db, installationId, kind, sourceId, expectedSourceRevision),
    projectCurrent: ({ source, authorization }) =>
      project(kind, source, authorization),
    authorizeCurrentReference: async (authority, input) => {
      assertAuthority(authority);
      const source = await load(
        db,
        installationId,
        kind,
        input.sourceId,
        input.sourceRevision,
      );
      if (!source || source.sourcePolicyRevision !== input.sourcePolicyRevision)
        throw denied();
      return authorizationOf(source);
    },
    hydrateCurrentReference: async (authority, input) => {
      assertAuthority(authority);
      const source = await load(
        db,
        installationId,
        kind,
        input.sourceId,
        input.sourceRevision,
      );
      if (!source || source.sourcePolicyRevision !== input.sourcePolicyRevision)
        throw denied();
      return source.canonical;
    },
  };
}

async function enumerate(
  db: D1DatabaseLike,
  installationId: string,
  kind: WorkshopSearchSourceKind,
  cursor: string | null,
  limit: number,
): Promise<{ sourceIds: readonly string[]; nextCursor: string | null }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw denied();
  const after = cursor ?? '';
  const table = tableFor(kind);
  const id = idColumnFor(kind);
  const deleted = kind === 'task' ? '1 = 1' : 'deleted_at IS NULL';
  const rows = await db
    .prepare(
      `SELECT ${id} AS id FROM ${table}
       WHERE installation_id = ? AND ${id} > ? AND ${deleted}
         AND visibility_scope IS NOT NULL AND authorization_revision IS NOT NULL
       ORDER BY ${id} ASC LIMIT ?`,
    )
    .bind(installationId, after, limit + 1)
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
  expectedSourceRevision: string | null,
): Promise<ExternalSearchLoadedSourceV1 | null> {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw denied();
  const table = tableFor(kind);
  const id = idColumnFor(kind);
  const deleted = kind === 'task' ? '1 = 1' : 'deleted_at IS NULL';
  const row = await db
    .prepare(
      `SELECT * FROM ${table}
       WHERE installation_id = ? AND ${id} = ? AND ${deleted}`,
    )
    .bind(installationId, sourceId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const revision = integer(row.revision, 'revision');
  if (
    expectedSourceRevision !== null &&
    expectedSourceRevision !== String(revision)
  )
    return null;
  const canonical = canonicalOf(kind, row);
  return {
    sourceId,
    sourceRevision: String(revision),
    sourcePolicyRevision: integer(row.policy_revision, 'policy_revision'),
    canonical,
  };
}

function authorizationOf(
  source: ExternalSearchLoadedSourceV1,
): ExternalAuthorization {
  const canonical = record(source.canonical);
  return {
    version: 1,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    sourcePolicyRevision: source.sourcePolicyRevision,
    workspaceId: nullableString(canonical.workspaceId),
    ownerPrincipalId: string(canonical.ownerPrincipalId),
    visibility: normalizeVisibilityScope(
      canonical.visibility as VisibilityScopeV1,
    ),
  };
}

function project(
  kind: WorkshopSearchSourceKind,
  source: ExternalSearchLoadedSourceV1,
  authorization: ExternalAuthorization,
): Promise<{
  version: 1;
  documents: Array<{
    documentSlot: string;
    canonicalReference: UnifiedSearchReferenceV1;
    filterMetadata: UnifiedSearchFiltersV1;
    text: string;
    segments: SearchProjectionSegmentV1[];
  }>;
  replaceAll: true;
  removeDocumentSlots: string[];
}> {
  const canonical = record(source.canonical);
  const language = optionalString(canonical.language) ?? 'en';
  const fields: Array<[SearchProjectionFieldV1, string]> = [];
  let filters: UnifiedSearchFiltersV1 = emptyFilters(language);
  let reference: UnifiedSearchReferenceV1;
  if (kind === 'task') {
    reference = { kind, taskId: source.sourceId };
    push(fields, 'title', canonical.title);
    push(fields, 'description', canonical.objective);
    push(fields, 'description', canonical.description);
    push(fields, 'prompt', canonical.prompt);
    push(fields, 'description', stringify(canonical.constraints));
    push(fields, 'description', stringify(canonical.acceptanceCriteria));
    push(fields, 'description', stringify(canonical.relationships));
    const status = canonical.archivedAt
      ? 'archived'
      : canonical.completedAt
        ? 'completed'
        : canonical.claimed === true
          ? 'claimed'
          : 'unclaimed';
    push(fields, 'status', status);
    push(fields, 'content', canonical.assignedPrincipalId);
    push(fields, 'result', canonical.outcome);
    filters = {
      ...filters,
      byKind: { task: { statuses: [status] } },
    };
  } else if (kind === 'memory') {
    reference = { kind, memoryId: source.sourceId };
    push(fields, 'title', canonical.title);
    push(fields, 'description', canonical.description);
    push(fields, 'content', canonical.content);
    push(fields, 'content', stringify(canonical.applicability));
    push(fields, 'content', stringify(canonical.provenance));
  } else {
    reference = { kind, promptId: source.sourceId };
    push(fields, 'title', canonical.name);
    push(fields, 'title', canonical.title);
    push(fields, 'prompt', canonical.promptText);
    push(fields, 'content', canonical.scope);
    push(fields, 'content', canonical.role);
    push(fields, 'content', stringify(canonical.variables));
    push(fields, 'status', canonical.active === true ? 'active' : 'inactive');
    push(fields, 'content', String(canonical.priority));
    push(fields, 'content', String(canonical.order));
  }
  const { text, segments } = combine(source.sourceId, language, fields);
  if (text.length === 0) throw denied();
  if (
    authorization.sourceId !== source.sourceId ||
    authorization.sourceRevision !== source.sourceRevision ||
    authorization.sourcePolicyRevision !== source.sourcePolicyRevision
  )
    throw denied();
  return Promise.resolve({
    version: 1 as const,
    documents: [
      {
        documentSlot: 'canonical',
        canonicalReference: reference,
        filterMetadata: filters,
        text,
        segments,
      },
    ],
    replaceAll: true as const,
    removeDocumentSlots: [],
  });
}

function canonicalOf(
  kind: WorkshopSearchSourceKind,
  row: Record<string, unknown>,
) {
  const shared = {
    id: string(row[idColumnFor(kind)]),
    revision: integer(row.revision, 'revision'),
    policyRevision: integer(row.policy_revision, 'policy_revision'),
    language: string(row.language),
    attribution: json(row.attribution_json),
    installationId: string(row.installation_id),
    ownerPrincipalId: string(row.owner_principal_id),
    workspaceId: string(row.workspace_id),
    visibility: visibility(row.visibility_scope),
    authorizationRevision: integer(
      row.authorization_revision,
      'authorization_revision',
    ),
    createdAt: string(row.created_at),
    updatedAt: string(row.updated_at),
  };
  if (kind === 'task')
    return {
      ...shared,
      title: string(row.title),
      ...(optionalString(row.objective)
        ? { objective: optionalString(row.objective) }
        : {}),
      description: string(row.description),
      constraints: json(row.constraints_json),
      acceptanceCriteria: json(row.acceptance_criteria_json),
      relationships: json(row.relationships_json),
      ...(optionalString(row.role) ? { role: optionalString(row.role) } : {}),
      prompt: string(row.prompt),
      claimed: integer(row.claimed, 'claimed') === 1,
      ...(optionalString(row.claimed_at)
        ? { claimedAt: normalizeDate(string(row.claimed_at)) }
        : {}),
      ...(optionalString(row.completed_at)
        ? { completedAt: normalizeDate(string(row.completed_at)) }
        : {}),
      ...(optionalString(row.archived_at)
        ? { archivedAt: normalizeDate(string(row.archived_at)) }
        : {}),
      ...(optionalString(row.assigned_principal_id)
        ? { assignedPrincipalId: optionalString(row.assigned_principal_id) }
        : {}),
      ...(optionalString(row.result)
        ? { result: optionalString(row.result) }
        : {}),
      ...(optionalString(row.outcome_kind)
        ? { outcomeKind: optionalString(row.outcome_kind) }
        : {}),
      memorySlugs: json(row.memory_slugs),
      contextQueries: json(row.context_queries),
    };
  if (kind === 'memory') {
    const { id, ...memoryShared } = shared;
    return {
      ...memoryShared,
      slug: id,
      title: string(row.title),
      description: string(row.description),
      content: string(row.content),
      applicability: json(row.applicability_json),
      provenance: json(row.provenance_json),
    };
  }
  return {
    ...shared,
    name: string(row.name),
    title: string(row.title),
    promptText: string(row.prompt_text),
    ...(optionalString(row.scope) ? { scope: optionalString(row.scope) } : {}),
    ...(optionalString(row.role) ? { role: optionalString(row.role) } : {}),
    variables: json(row.variables_json),
    active: integer(row.active, 'active') === 1,
    priority: integer(row.priority, 'priority'),
    order: integer(row.sort_order, 'sort_order'),
    ...(optionalString(row.deactivated_at)
      ? { deactivatedAt: optionalString(row.deactivated_at) }
      : {}),
  };
}

function combine(
  sourceId: string,
  language: string,
  fields: readonly [SearchProjectionFieldV1, string][],
): { text: string; segments: SearchProjectionSegmentV1[] } {
  let text = '';
  const segments: SearchProjectionSegmentV1[] = [];
  for (const [field, value] of fields) {
    if (text) text += '\n';
    const start = text.length;
    text += value;
    segments.push({
      field,
      sourceId,
      language,
      text: value,
      documentStart: start,
      documentEnd: text.length,
    });
  }
  return { text, segments };
}

function emptyFilters(language: string): UnifiedSearchFiltersV1 {
  return {
    languages: [language],
    sourceRevisions: [],
    byKind: {},
  };
}

function push(
  fields: Array<[SearchProjectionFieldV1, string]>,
  field: SearchProjectionFieldV1,
  value: unknown,
): void {
  if (typeof value === 'string' && value.trim()) fields.push([field, value]);
}

function tableFor(kind: WorkshopSearchSourceKind): string {
  return kind === 'task'
    ? 'workshop_tasks'
    : kind === 'memory'
      ? 'workshop_memories'
      : 'workshop_prompts';
}

function idColumnFor(kind: WorkshopSearchSourceKind): string {
  return kind === 'task' ? 'id' : kind === 'memory' ? 'slug' : 'id';
}

function capabilityFor(kind: WorkshopSearchSourceKind): string {
  return kind === 'task'
    ? 'task-write'
    : kind === 'memory'
      ? 'memory-write'
      : 'prompt-write';
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

function normalizeDate(value: string): string {
  return new Date(
    value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
  ).toISOString();
}

function visibility(value: unknown): VisibilityScopeV1 {
  const parsed = json(value);
  const normalized = normalizeVisibilityScope(parsed as VisibilityScopeV1);
  if (serializeVisibilityScope(normalized) !== String(value)) throw denied();
  return normalized;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') throw denied();
  try {
    return JSON.parse(value);
  } catch {
    throw denied();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw denied();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw denied();
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value);
}

function integer(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new WorkshopError('internal_error', `Invalid canonical ${field}`);
  return number;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertAuthority(value: { readonly kind: string }): void {
  if (value.kind !== 'taproot-external-search-domain-policy-authority-v1')
    throw denied();
}

function denied(): WorkshopError {
  return new WorkshopError('forbidden', 'Authorization denied');
}
