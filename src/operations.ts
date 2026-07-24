import Ajv, { type ValidateFunction } from 'ajv';
import {
  CATALOG_DIGEST,
  OPERATION_SCHEMA_VERSION,
  operationCatalog,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from './generated/operations.js';
import { WorkshopError, normalizeWorkshopError } from './protocol/errors.js';
import {
  assertSearchResultIdentity,
  type WorkshopSearchResultIdentity,
} from './protocol/catalog.js';
import type { AuthenticatedPrincipal, WorkshopCapability } from './protocol.js';

const IDENTITY_ARGUMENTS = new Set([
  'installationId',
  'principalId',
  'activeWorkspaceId',
  'workspaceIds',
  'capabilities',
  'authorizationRevision',
  'credentialId',
  'actorPrincipalId',
]);

export interface OperationCallContext {
  principal: AuthenticatedPrincipal;
  requestId: string;
  signal: AbortSignal;
}

export interface WorkshopStatusSnapshot {
  baseIri: string;
  migrations: {
    namespace: '@gnolith/workshop';
    version: number;
    ready: boolean;
  };
  compatibility: { diamond: boolean; taproot: boolean };
  canonicalReady: boolean;
  authorizationReady: boolean;
  lexicalReady: boolean;
  semantic: {
    state: 'ready' | 'degraded' | 'unconfigured';
    configured: boolean;
  };
  producers: {
    ready: boolean;
    fingerprint: string;
    kinds: readonly ['task', 'memory', 'prompt'];
  };
  blobReady: boolean;
}

export interface TaprootOperationPort {
  call(
    name: OperationName,
    input: Readonly<Record<string, unknown>>,
    context: OperationCallContext,
  ): Promise<unknown>;
  createScopedSparqlView(context: OperationCallContext): Promise<unknown>;
  recheckPrincipal(
    principal: AuthenticatedPrincipal,
    signal: AbortSignal,
  ): Promise<AuthenticatedPrincipal>;
  status(
    principal: AuthenticatedPrincipal,
    signal: AbortSignal,
  ): Promise<WorkshopStatusSnapshot>;
}

export interface DiamondSparqlPort {
  validate(query: string, options: { signal: AbortSignal }): Promise<unknown>;
  query(
    scopedView: unknown,
    query: string,
    options: {
      dryRun: boolean;
      limit?: number;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface WorkshopDomainOperationPort {
  call(
    name: OperationName,
    input: Readonly<Record<string, unknown>>,
    context: OperationCallContext,
  ): Promise<unknown>;
}

export interface OperationObservation {
  operation: OperationName;
  operationVersion: 1;
  requestId: string;
  principalId: string;
  outcome: 'success' | 'error';
  durationMs: number;
  errorCode?: string;
}

export interface OperationRuntimeOptions {
  version: string;
  taproot: TaprootOperationPort;
  diamond: DiamondSparqlPort;
  workshop: WorkshopDomainOperationPort;
  observe?: (event: OperationObservation) => void | Promise<void>;
}

export interface OperationRuntime {
  readonly catalog: typeof operationCatalog;
  readonly catalogDigest: typeof CATALOG_DIGEST;
  call<Name extends OperationName>(
    name: Name,
    input: OperationInput<Name>,
    context: OperationCallContext,
  ): Promise<OperationOutput<Name>>;
}

const TAPROOT_NAMES = new Set<OperationName>([
  'search',
  'search_hydrate',
  'search_admin',
  'get_entity',
  'get_entities',
  'create_item',
  'create_property',
  'mutate_entity',
  'entity_history',
  'entity_revision',
  'statement_history',
  'statement_revision',
  'export_entity_json',
  'create_resource',
  'get_resource',
  'update_resource',
  'delete_resource',
  'hydrate_resource',
  'resource_history',
  'resource_revision',
  'create_annotation',
  'get_annotation',
  'update_annotation',
  'delete_annotation',
  'annotation_history',
  'annotation_revision',
]);
const WORKSHOP_NAMES = new Set<OperationName>([
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

export function createOperationRuntime(
  options: OperationRuntimeOptions,
): OperationRuntime {
  const validators = validatorsForCatalog();
  const definitions = new Map(
    operationCatalog.map((definition) => [definition.name, definition]),
  );
  return {
    catalog: operationCatalog,
    catalogDigest: CATALOG_DIGEST,
    async call<Name extends OperationName>(
      name: Name,
      input: OperationInput<Name>,
      context: OperationCallContext,
    ): Promise<OperationOutput<Name>> {
      const started = performance.now();
      let live: AuthenticatedPrincipal | undefined;
      try {
        const definition = definitions.get(name);
        if (!definition)
          throw new WorkshopError('not_found', 'Operation not found', 404);
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw invalid('Operation input must be an object');
        rejectForgedIdentity(input);
        const validate = validators.get(name);
        if (!validate?.(input))
          throw new WorkshopError(
            'validation_failed',
            'Operation input does not match its schema',
            400,
            { operation: name, errors: boundedAjvErrors(validate?.errors) },
          );
        live = await options.taproot.recheckPrincipal(
          context.principal,
          context.signal,
        );
        requireExactCapability(live.capabilities, definition.capability);
        const liveContext = { ...context, principal: live };
        let value: unknown;
        if (name === 'gnolith_status') {
          const status = await options.taproot.status(live, context.signal);
          value = {
            installationId: live.installationId,
            baseIri: status.baseIri,
            principalId: live.principalId,
            credentialId: live.credentialId,
            activeWorkspaceId: live.activeWorkspaceId,
            capabilities: [...live.capabilities],
            authorizationRevision: live.authorizationRevision,
            migrationReadiness: status.migrations,
            compatibility: status.compatibility,
            canonicalReady: status.canonicalReady,
            authorizationReady: status.authorizationReady,
            lexicalReady: status.lexicalReady,
            semanticState: status.semantic,
            producers: status.producers,
            blobReady: status.blobReady,
            versions: {
              server: options.version,
              operationSchema: OPERATION_SCHEMA_VERSION,
            },
            operationCatalogDigest: CATALOG_DIGEST,
          };
        } else if (name === 'validate_sparql') {
          value = await options.diamond.validate(String(input.query), {
            signal: context.signal,
          });
        } else if (name === 'query_sparql') {
          const scopedView =
            await options.taproot.createScopedSparqlView(liveContext);
          value = await options.diamond.query(scopedView, String(input.query), {
            dryRun: input.dryRun === true,
            ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
            signal: context.signal,
          });
        } else if (TAPROOT_NAMES.has(name)) {
          value = await options.taproot.call(name, input, liveContext);
        } else if (WORKSHOP_NAMES.has(name)) {
          value = await options.workshop.call(name, input, liveContext);
        } else {
          throw new WorkshopError(
            'internal_error',
            'Operation is not bound',
            500,
          );
        }
        if (name === 'search') validateSearchPage(value);
        const outputValidator = validators.get(`${name}:output`);
        if (!outputValidator?.(value))
          throw new WorkshopError(
            'internal_error',
            'Operation output does not match its schema',
            500,
          );
        await observe(options, {
          operation: name,
          operationVersion: 1,
          requestId: context.requestId,
          principalId: live.principalId,
          outcome: 'success',
          durationMs: performance.now() - started,
        });
        return value as OperationOutput<Name>;
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        await observe(options, {
          operation: name,
          operationVersion: 1,
          requestId: context.requestId,
          principalId: live?.principalId ?? context.principal.principalId,
          outcome: 'error',
          durationMs: performance.now() - started,
          errorCode: normalized.code,
        });
        throw normalized;
      }
    },
  };
}

function validatorsForCatalog(): Map<string, ValidateFunction> {
  const AjvConstructor = Ajv as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile(schema: unknown): ValidateFunction;
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: true });
  const validators = new Map<string, ValidateFunction>();
  for (const operation of operationCatalog) {
    validators.set(operation.name, ajv.compile(operation.inputSchema));
    validators.set(
      `${operation.name}:output`,
      ajv.compile(operation.outputSchema),
    );
  }
  return validators;
}

function rejectForgedIdentity(input: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(input)) {
    if (IDENTITY_ARGUMENTS.has(key))
      throw invalid('Identity and authorization are transport-owned');
  }
}

function requireExactCapability(
  capabilities: readonly string[],
  required: WorkshopCapability,
): void {
  if (!capabilities.includes(required))
    throw new WorkshopError('forbidden', 'Authorization denied', 403);
}

function validateSearchPage(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  for (const item of items)
    assertSearchResultIdentity(item as WorkshopSearchResultIdentity);
}

function boundedAjvErrors(errors: ValidateFunction['errors']): unknown[] {
  return (errors ?? []).slice(0, 20).map((error) => ({
    instancePath: error.instancePath.slice(0, 256),
    keyword: error.keyword.slice(0, 64),
    message: error.message?.slice(0, 256),
  }));
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}

async function observe(
  options: OperationRuntimeOptions,
  event: OperationObservation,
): Promise<void> {
  try {
    await options.observe?.(event);
  } catch {
    // Observability never changes operation outcomes.
  }
}
