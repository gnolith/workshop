import {
  createAuthorizedTaproot,
  createTaprootWorkshopPortV1,
  TaprootContentRepositoryV1,
  type AuthorizationContext,
  type AuthorizationCursorCodec,
  type CreateAnnotationInputV1,
  type CreateItemInput,
  type CreatePropertyInput,
  type CreateResourceInputV1,
  type D1DatabaseLike,
  type EntityCommand,
  type EntityId,
  type PortableResourcePayloadStoreV1,
  type TaprootHostWriteCapability,
  type TaprootOptions,
  type TaprootWorkshopPortV1,
} from '@gnolith/taproot';
import {
  createAuthorizedSearchServiceV1,
  createSearchMaterializationAdminGuardV1,
  type AuthorizedSearchServiceV1,
  type SearchMaterializationAdminGuardV1,
  type SearchKind,
  type SearchResultV1,
  type SemanticSearchAdminV1,
  type SearchMaterializationHealthV1,
} from '@gnolith/taproot/search';
import { prepareScopedSparqlPolicyV1 } from '@gnolith/taproot/sparql-policy';
import type { OperationName } from './generated/operations.js';
import type {
  OperationCallContext,
  TaprootOperationPort,
  WorkshopStatusSnapshot,
} from './operations.js';
import type { AuthenticatedPrincipal } from './protocol.js';
import { WorkshopError } from './protocol/errors.js';
import type { WorkshopAuthorizedSearchServiceV1 } from './server/search.js';
import type { D1DatabaseLike as WorkshopD1DatabaseLike } from './server/database.js';
import {
  createWorkshopAuthorizationAdministrationV1,
  type WorkshopAuthorizationAdministrationV1,
} from './authorization-administration.js';
import { configureWorkshopSemanticsV1 } from './semantic-configuration.js';

export interface WorkshopTaprootAssemblyOptionsV1 {
  kind: 'workshop-taproot-assembly-v1';
  db: D1DatabaseLike;
  installationId: string;
  taprootOptions: TaprootOptions;
  hostAuthority: TaprootHostWriteCapability;
  cursorCodec: AuthorizationCursorCodec;
  payloadStore?: PortableResourcePayloadStoreV1;
  maxHydratedResourceBytes?: number;
  semantic?: SemanticSearchAdminV1;
  search?: WorkshopAuthorizedSearchServiceV1;
  materialization?: SearchMaterializationAdminGuardV1;
  authorizationAdministration?: WorkshopAuthorizationAdministrationV1;
  status(
    context: AuthorizationContext,
    signal: AbortSignal,
  ): Promise<WorkshopStatusSnapshot>;
}

interface TaprootRuntimeV1 {
  operator: TaprootWorkshopPortV1;
  content: TaprootContentRepositoryV1;
  search: AuthorizedSearchServiceV1;
  materialization: SearchMaterializationAdminGuardV1;
  authorizationAdministration: WorkshopAuthorizationAdministrationV1;
}

/** Composes only packed Taproot public capabilities into Workshop's catalog. */
export async function createWorkshopTaprootOperationPortV1(
  options: WorkshopTaprootAssemblyOptionsV1,
): Promise<TaprootOperationPort> {
  validateAssembly(options);
  const content = new TaprootContentRepositoryV1(options.db, {
    installationId: options.installationId,
    ...(options.payloadStore ? { payloadStore: options.payloadStore } : {}),
  });
  const runtime: TaprootRuntimeV1 = {
    operator: await createTaprootWorkshopPortV1(
      options.db,
      options.taprootOptions,
      options.hostAuthority,
      {
        installationId: options.installationId,
        ...(options.payloadStore ? { payloadStore: options.payloadStore } : {}),
        ...(options.maxHydratedResourceBytes === undefined
          ? {}
          : {
              maxHydratedResourceBytes: options.maxHydratedResourceBytes,
            }),
      },
    ),
    content,
    search: options.search
      ? (options.search as unknown as AuthorizedSearchServiceV1)
      : createAuthorizedSearchServiceV1(options.db, {
          installationId: options.installationId,
          content,
          ...(options.semantic ? { semantic: options.semantic } : {}),
        }),
    materialization:
      options.materialization ??
      (await createSearchMaterializationAdminGuardV1(
        options.db,
        options.taprootOptions,
        options.hostAuthority,
        options.payloadStore
          ? { payloadStore: options.payloadStore }
          : undefined,
      )),
    authorizationAdministration:
      options.authorizationAdministration ??
      (await createWorkshopAuthorizationAdministrationV1({
        db: options.db as unknown as WorkshopD1DatabaseLike,
        taprootOptions: options.taprootOptions,
        hostAuthority: options.hostAuthority,
        installationId: options.installationId,
      })),
  };
  if (runtime.operator.kind !== 'taproot-workshop-port-v1')
    throw unavailable('Taproot Workshop operator port is incompatible');

  const port: TaprootOperationPort = {
    async recheckPrincipal(principal, signal) {
      signal.throwIfAborted();
      let live: Awaited<
        ReturnType<TaprootWorkshopPortV1['resolveAuthorization']>
      >;
      try {
        live = await runtime.operator.resolveAuthorization({
          principalId: principal.principalId,
          activeWorkspaceId: principal.activeWorkspaceId,
        });
      } catch (error) {
        if (
          (error as { name?: unknown }).name === 'AuthorizationDeniedError' ||
          (error as { code?: unknown }).code === 'AUTHORIZATION_DENIED'
        )
          throw new WorkshopError('forbidden', 'Authorization denied', 403);
        throw error;
      }
      assertInstallation(options.installationId, live.installationId);
      const resolved = {
        ...live,
        credentialId: principal.credentialId,
      };
      await runtime.authorizationAdministration.assertPrincipalActive(resolved);
      return resolved;
    },
    status(principal, signal) {
      return options.status(authorization(principal), signal);
    },
    createScopedSparqlView(context) {
      return prepareScopedSparqlPolicyV1(
        options.db,
        {
          installationId: options.installationId,
          baseIri: options.taprootOptions.baseIri,
        },
        authorization(context.principal),
      );
    },
    call(name, input, context) {
      return callTaproot(runtime, options, name, input, context);
    },
  };
  return Object.freeze(port);
}

async function callTaproot(
  runtime: TaprootRuntimeV1,
  options: WorkshopTaprootAssemblyOptionsV1,
  name: OperationName,
  input: Readonly<Record<string, unknown>>,
  callContext: OperationCallContext,
): Promise<unknown> {
  const context = authorization(callContext.principal);
  const reader = createAuthorizedTaproot(
    options.db,
    options.taprootOptions,
    context,
    { cursorCodec: options.cursorCodec },
  );
  switch (name) {
    case 'authorization_admin':
      return runtime.authorizationAdministration.call(input, callContext);
    case 'search': {
      let page: Awaited<ReturnType<AuthorizedSearchServiceV1['search']>>;
      try {
        page = await runtime.search.search(
          {
            text: requiredString(input.text),
            ...(Array.isArray(input.kinds)
              ? { kinds: input.kinds as SearchKind[] }
              : {}),
            ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
            ...(typeof input.cursor === 'string'
              ? { cursor: input.cursor }
              : {}),
          },
          context,
        );
      } catch (error) {
        if (typeof input.cursor === 'string')
          throw new WorkshopError(
            'invalid_cursor',
            'Search cursor is invalid',
            400,
          );
        throw error;
      }
      return {
        items: page.results.map((result) => ({
          ...result,
          id: result.sourceId,
          revision: numericRevision(result.sourceRevision),
        })),
        cursor: page.cursor ?? null,
      };
    }
    case 'search_hydrate':
      return runtime.search.hydrate(hydrationIdentity(input), context);
    case 'search_admin':
      return searchAdministration(
        runtime,
        options,
        input,
        context,
        callContext,
      );
    case 'get_entity':
      return reader.getEntity(requiredEntityId(input.entityId));
    case 'get_entities':
      return {
        items: await Promise.all(
          (input.entityIds as unknown[]).map((id) =>
            reader.getEntity(requiredEntityId(id)),
          ),
        ),
      };
    case 'entity_history':
      return reader.listEntityRevisions(requiredEntityId(input.entityId));
    case 'entity_revision':
      return reader.getEntityRevision(
        requiredEntityId(input.entityId),
        Number(input.revision),
      );
    case 'statement_history':
      return runtime.operator.statementHistory(
        requiredString(input.statementId),
        {},
        context,
      );
    case 'statement_revision':
      return runtime.operator.statementRevision(
        requiredString(input.statementId),
        Number(input.revision),
        context,
      );
    case 'export_entity_json': {
      const value = await reader.getEntity(requiredEntityId(input.entityId));
      return { entityId: input.entityId, value };
    }
    case 'create_item':
      return runtime.operator.createItem(
        createEntityInput<CreateItemInput>(input),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'create_property':
      return runtime.operator.createProperty(
        createEntityInput<CreatePropertyInput>(input),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'mutate_entity':
      return runtime.operator.mutateEntity(
        requiredEntityId(input.entityId),
        mutations(input.mutations),
        {
          expectedRevision: Number(input.expectedRevision),
          idempotencyKey: requiredString(input.idempotencyKey),
        },
        context,
      );
    case 'create_resource':
      return runtime.operator.createResource(
        domainInput<CreateResourceInputV1>(input.data),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'get_resource':
      return runtime.content.getResource(
        requiredString(input.resourceId),
        context,
      );
    case 'update_resource': {
      const resourceId = requiredString(input.resourceId);
      const current = await runtime.content.getResource(resourceId, context);
      return runtime.operator.updateResource(
        resourceId,
        Number(input.expectedRevision),
        resourceUpdateInput(current, input.patch),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    }
    case 'delete_resource':
      return runtime.operator.deleteResource(
        requiredString(input.resourceId),
        Number(input.expectedRevision),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'hydrate_resource': {
      const resourceId = requiredString(input.resourceId);
      const revision = Number(input.revision);
      const bytes = await runtime.operator.hydrateResource(
        resourceId,
        revision,
        context,
        callContext.signal,
      );
      return {
        resourceId,
        revision,
        encoding: 'base64',
        byteLength: bytes.byteLength,
        data: Buffer.from(bytes).toString('base64'),
      };
    }
    case 'resource_history':
      return runtime.operator.resourceHistory(
        requiredString(input.resourceId),
        {},
        context,
      );
    case 'resource_revision':
      return runtime.operator.resourceRevision(
        requiredString(input.resourceId),
        Number(input.revision),
        context,
      );
    case 'create_annotation':
      return runtime.operator.createAnnotation(
        domainInput<CreateAnnotationInputV1>(input.data),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'get_annotation':
      return runtime.content.getAnnotation(
        requiredString(input.annotationId),
        context,
      );
    case 'update_annotation': {
      const annotationId = requiredString(input.annotationId);
      const current = await runtime.content.getAnnotation(
        annotationId,
        context,
      );
      return runtime.operator.updateAnnotation(
        annotationId,
        Number(input.expectedRevision),
        annotationUpdateInput(current, input.patch),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    }
    case 'delete_annotation':
      return runtime.operator.deleteAnnotation(
        requiredString(input.annotationId),
        Number(input.expectedRevision),
        { idempotencyKey: requiredString(input.idempotencyKey) },
        context,
      );
    case 'annotation_history':
      return runtime.operator.annotationHistory(
        requiredString(input.annotationId),
        {},
        context,
      );
    case 'annotation_revision':
      return runtime.operator.annotationRevision(
        requiredString(input.annotationId),
        Number(input.revision),
        context,
      );
    default:
      throw new WorkshopError('not_found', 'Operation not found', 404);
  }
}

async function searchAdministration(
  runtime: TaprootRuntimeV1,
  options: WorkshopTaprootAssemblyOptionsV1,
  input: Readonly<Record<string, unknown>>,
  context: AuthorizationContext,
  callContext: OperationCallContext,
): Promise<unknown> {
  callContext.signal.throwIfAborted();
  const action = requiredString(input.action);
  const values = record(input.options ?? {});
  const limit = typeof input.limit === 'number' ? input.limit : 100;
  switch (action) {
    case 'health':
      return {
        materialization: truthfulMaterializationHealth(
          await runtime.materialization.health(context),
        ),
        semantic: options.semantic
          ? await options.semantic.status(context)
          : { state: 'unconfigured' },
      };
    case 'materialize': {
      const receipt = await runtime.materialization.run(context, {
        maxJobs: limit,
        maxRebuildRoots: optionalInteger(values.maxRebuildRoots, limit),
        ...(typeof values.maxChunkBytes === 'number'
          ? { maxChunkBytes: values.maxChunkBytes }
          : {}),
      });
      const health = truthfulMaterializationHealth(
        await runtime.materialization.health(context),
      );
      return {
        claimed: receipt.claimed,
        completed: receipt.completed,
        superseded: receipt.superseded,
        deferred: receipt.deferred,
        dead: receipt.dead,
        rebuildRootsEnumerated: receipt.rebuildRootsEnumerated,
        job: {
          state: 'completed',
          requestedLimit: limit,
        },
        result: { ...receipt },
        health,
      };
    }
    case 'retry-dead':
      return {
        retried: await runtime.materialization.retryDead(context, { limit }),
      };
    case 'rebuild':
      return {
        generation: await runtime.materialization.startShadowRebuild(context),
      };
    case 'activate':
      return {
        generation: await runtime.materialization.activateReadyShadow(context),
      };
  }
  const semantic = options.semantic;
  if (!semantic) throw unavailable('Semantic search is not configured');
  switch (action) {
    case 'configure':
      return configureWorkshopSemanticsV1(
        {
          version: 1,
          expectedRevision: Number(values.expectedRevision),
          idempotencyKey: requiredString(values.idempotencyKey),
          configuration: values.configuration as never,
        },
        {
          db: options.db as unknown as WorkshopD1DatabaseLike,
          installationId: options.installationId,
          semantic,
          authorization: context,
        },
      );
    case 'semantic-select':
      await semantic.select(requiredString(values.configurationId), context);
      return semantic.status(context);
    case 'semantic-reconnect':
      return {
        connected: await semantic.reconnect(
          requiredString(values.configurationId),
          context,
        ),
      };
    case 'semantic-estimate':
      return semantic.estimate(
        requiredString(values.configurationId),
        values.policy as never,
        context,
      );
    case 'semantic-approve':
      await semantic.approve(requiredString(values.planId), context);
      return semantic.status(context);
    case 'semantic-run':
      return semantic.run(
        requiredString(values.planId),
        context,
        callContext.signal,
      );
    case 'semantic-resume':
      return semantic.resume(
        requiredString(values.planId),
        context,
        callContext.signal,
      );
    case 'semantic-pause':
      await semantic.pause(requiredString(values.planId), context);
      return semantic.status(context);
    case 'semantic-stop':
      await semantic.stop(requiredString(values.planId), context);
      return semantic.status(context);
    case 'semantic-retry':
      await semantic.retry(requiredString(values.planId), context);
      return semantic.status(context);
    case 'semantic-exclude':
      await semantic.exclude(
        requiredString(values.configurationId),
        Number(values.generation),
        requiredString(values.derivedId),
        requiredString(values.reason),
        context,
      );
      return semantic.status(context);
    case 'semantic-retire':
      await semantic.retire(requiredString(values.configurationId), context);
      return semantic.status(context);
    case 'semantic-delete':
      await semantic.deleteEmbeddings(
        requiredString(values.configurationId),
        context,
      );
      return semantic.status(context);
    default:
      throw new WorkshopError(
        'validation_failed',
        'Search action is invalid',
        400,
      );
  }
}

export function truthfulMaterializationHealth(
  health: SearchMaterializationHealthV1,
): SearchMaterializationHealthV1 {
  if (
    health.status === 'healthy' &&
    health.activeAppliedWatermark < health.sourceHighWatermark
  )
    return { ...health, status: 'building' };
  return health;
}

function authorization(
  principal: AuthenticatedPrincipal,
): AuthorizationContext {
  if (!principal.workspaceIds)
    throw unavailable('Live Taproot authorization context is unavailable');
  return {
    installationId: principal.installationId,
    principalId: principal.principalId,
    activeWorkspaceId: principal.activeWorkspaceId,
    workspaceIds: principal.workspaceIds,
    capabilities: principal.capabilities,
    authorizationRevision: principal.authorizationRevision,
  };
}

function createEntityInput<T>(input: Readonly<Record<string, unknown>>): T {
  const data = domainInput<Record<string, unknown>>(input.data);
  return {
    ...data,
    editSummary: requiredString(input.authoredText),
  } as T;
}

function mutations(value: unknown) {
  if (!Array.isArray(value)) throw invalid('Entity mutations are invalid');
  return value.map((entry) => {
    const mutation = record(entry);
    const command = domainInput<EntityCommand>(mutation.value);
    const kind = requiredString(mutation.kind);
    if (!commandMatchesKind(command.type, kind))
      throw invalid('Entity mutation kind does not match its command');
    return {
      command,
      authoredText: requiredString(mutation.authoredText),
    };
  });
}

function commandMatchesKind(
  type: EntityCommand['type'],
  kind: string,
): boolean {
  const prefix = type.includes('label')
    ? 'label'
    : type.includes('description')
      ? 'description'
      : type.includes('alias')
        ? 'alias'
        : type.includes('sitelink')
          ? 'sitelink'
          : type.includes('statement-rank')
            ? 'rank'
            : type.includes('statement')
              ? 'statement'
              : type.includes('qualifier')
                ? 'qualifier'
                : type.includes('reference')
                  ? 'reference'
                  : '';
  return prefix === kind;
}

function hydrationIdentity(
  input: Readonly<Record<string, unknown>>,
): SearchResultV1 {
  const shared = {
    sourceId: requiredString(input.id),
    sourceRevision: String(input.revision),
    score: 0,
    snippet: '',
  };
  if (input.kind === 'item') {
    if (input.entityType !== 'item' && input.entityType !== 'property')
      throw invalid('Item search identity requires entityType');
    return { ...shared, kind: 'item', entityType: input.entityType };
  }
  return { ...shared, kind: input.kind as Exclude<SearchKind, 'item'> };
}

function resourceUpdateInput(
  current: Awaited<ReturnType<TaprootContentRepositoryV1['getResource']>>,
  patchValue: unknown,
): CreateResourceInputV1 {
  const patch = domainInput<Partial<CreateResourceInputV1>>(patchValue);
  return {
    ...(current.title ? { title: current.title } : {}),
    payload: current.payload,
    mediaType: current.mediaType,
    ...(current.language ? { language: current.language } : {}),
    integrity: current.integrity,
    ...patch,
    id: current.id,
    itemId: current.itemId,
  };
}

function annotationUpdateInput(
  current: Awaited<ReturnType<TaprootContentRepositoryV1['getAnnotation']>>,
  patchValue: unknown,
): CreateAnnotationInputV1 {
  const patch = domainInput<Partial<CreateAnnotationInputV1>>(patchValue);
  return {
    body: current.body,
    target: current.target,
    ...(current.motivation ? { motivation: current.motivation } : {}),
    ...(current.creator ? { creator: current.creator } : {}),
    ...(current.generator ? { generator: current.generator } : {}),
    ...(current.language ? { language: current.language } : {}),
    ...(current.mediaType ? { mediaType: current.mediaType } : {}),
    ...patch,
    id: current.id,
  };
}

function domainInput<T>(value: unknown): T {
  const input = record(value);
  for (const key of [
    'authorization',
    'authorizationContext',
    'installationId',
    'ownerPrincipalId',
    'workspaceId',
    'policyRevision',
    'authorizationRevision',
    'actor',
    'attribution',
    'requestId',
  ]) {
    if (key in input)
      throw invalid('Identity, policy, and attribution are server-owned');
  }
  return { ...input } as T;
}

function validateAssembly(options: WorkshopTaprootAssemblyOptionsV1): void {
  if (
    options.kind !== 'workshop-taproot-assembly-v1' ||
    !options.installationId ||
    !options.db ||
    !options.hostAuthority ||
    !options.cursorCodec ||
    typeof options.status !== 'function'
  )
    throw invalid('Taproot assembly is incomplete');
}

function requiredEntityId(value: unknown): EntityId {
  const id = requiredString(value);
  if (!/^[PQ][1-9][0-9]*$/u.test(id)) throw invalid('Entity id is invalid');
  return id as EntityId;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw invalid('Required text is invalid');
  return value;
}

function numericRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw unavailable('Search result revision is incompatible');
  return revision;
}

function optionalInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('Expected an object');
  return value as Readonly<Record<string, unknown>>;
}

function assertInstallation(expected: string, actual: string): void {
  if (expected !== actual)
    throw unavailable('Taproot authorization installation is incompatible');
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}

function unavailable(message: string): WorkshopError {
  return new WorkshopError('dependency_unavailable', message, 503);
}
