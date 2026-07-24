import { Buffer } from 'node:buffer';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import {
  createAuthorizedTaproot,
  commitAuthorizationBootstrapV1,
  createInstallationAuthorizationGuard,
  createTaprootWorkshopPortV1,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
  type AuthorizationContext as TaprootAuthorizationContext,
  type AuthorizationCursorCodec,
  type InstallationAuthorizationGuard,
  type PortableResourcePayloadStoreV1,
  type TaprootHostWriteCapability,
  type TaprootWriteOptions,
} from '@gnolith/taproot';
import {
  D1QuadSource,
  createMigrationLedgerBackupV1,
  registerMigrationLedgerOwnerV1,
  type MigrationAssemblyAuthority,
} from '@gnolith/diamond';
import {
  createSparqlExecutor,
  type SparqlExecutorOptions,
} from '@gnolith/diamond/sparql';
import type * as RDF from '@rdfjs/types';
import {
  createWorkshopOwnerHandlesV1,
  type WorkshopOwnerHandlesV1,
} from './backup.js';
import { createWorkshopBootstrapOwnerAdapterV1 } from './bootstrap.js';
import type { ProtectedReader } from './executable.js';
import type {
  DiamondSparqlPort,
  WorkshopStatusSnapshot,
} from './operations.js';
import { workshopNamespacedMigrationsV1 } from './migrations.js';
import {
  bindWorkshopProducerHandles,
  type WorkshopProducerBindingExpectation,
} from './producers.js';
import { WorkshopError } from './protocol/errors.js';
import {
  createAuthenticationVerifier,
  createWorkshopLocalBearerCredentialStoreV1,
} from './server/auth.js';
import type { VerifiedWaystoneAssets } from './server/assets.js';
import type { WorkshopServiceConfig } from './server/config.js';
import type { WorkshopCoreOptions } from './server/context.js';
import type {
  AuthorizationContext,
  InstallationAuthorizationState,
  WorkshopAuthorizationAuthority,
} from './server/authorization.js';
import type { WorkshopCursorCodec } from './server/cursor.js';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from './server/database.js';
import type { CloseableDependency } from './server/service.js';
import { createWorkshopSearchIntegrationV1 } from './server/search.js';
import {
  createWorkshopLocalExecutableAdapterV1,
  type WorkshopLocalExecutableAdapterV1,
  type WorkshopLocalExecutableDependenciesV1,
} from './local-adapter.js';

export interface WorkshopCursorSecretsV1 {
  generation: string;
  encryptionKey: CryptoKey;
  digestKey: CryptoKey;
}

export interface WorkshopLocalAssemblyPrimitivesV1 {
  kind: 'workshop-local-assembly-primitives-v1';
  version: string;
  db: D1DatabaseLike;
  installationId: string;
  registrationFingerprint: string;
  taproot: {
    options: TaprootWriteOptions;
    hostAuthority: TaprootHostWriteCapability;
    authorizationCursorCodec: AuthorizationCursorCodec;
    registrationPrincipal: {
      principalId: string;
      activeWorkspaceId: string | null;
    };
    payloadStore?: PortableResourcePayloadStoreV1;
    maxHydratedResourceBytes?: number;
  };
  diamond?: Omit<SparqlExecutorOptions, 'db' | 'sourceFactory'>;
  cursor: WorkshopCursorSecretsV1;
  migrationAssemblyAuthority: MigrationAssemblyAuthority;
  assets?: (
    config: WorkshopServiceConfig,
    protectedReader: ProtectedReader,
  ) => Promise<VerifiedWaystoneAssets | undefined>;
  dependencies?: readonly CloseableDependency[];
  workshop?: Omit<
    WorkshopCoreOptions,
    | 'persistence'
    | 'authorization'
    | 'knowledge'
    | 'diamondHealth'
    | 'cursorCodec'
    | 'search'
  >;
}

/**
 * Workshop-owned assembly boundary. The host supplies only opened databases,
 * protected keys, and public Diamond/Taproot capabilities.
 */
export async function createWorkshopLocalExecutableDependenciesV1(
  input: WorkshopLocalAssemblyPrimitivesV1,
): Promise<WorkshopLocalExecutableDependenciesV1> {
  validateInput(input);
  const ownerHandles = await createLocalOwnerHandles(input);
  return assembleExecutableDependencies(input, ownerHandles);
}

/**
 * Pristine-installation adapter. Bootstrap capabilities are available before
 * authorization exists; serve-time runtime dependencies are assembled lazily.
 */
export async function createWorkshopLocalExecutableAdapterFromPrimitivesV1(
  input: WorkshopLocalAssemblyPrimitivesV1,
): Promise<WorkshopLocalExecutableAdapterV1> {
  validateInput(input);
  const ownerHandles = await createLocalOwnerHandles(input);
  return Object.freeze({
    kind: 'workshop-local-executable-adapter-v1' as const,
    ownerHandles,
    async createWorkshopExecutable(
      config: WorkshopServiceConfig,
      protectedReader: ProtectedReader,
    ) {
      const dependencies = await assembleExecutableDependencies(
        input,
        ownerHandles,
      );
      const adapter =
        await createWorkshopLocalExecutableAdapterV1(dependencies);
      return adapter.createWorkshopExecutable(config, protectedReader);
    },
    async createWorkshopBootstrapDependencies() {
      const ownerAdapter = createWorkshopBootstrapOwnerAdapterV1(input.db);
      const ownerParticipantIssuer =
        await registerAuthorizationBootstrapOwnerV1(
          input.db,
          input.taproot.options,
          input.taproot.hostAuthority,
          {
            installationId: input.installationId,
            ownerRegistrationId: 'workshop',
            adapter: ownerAdapter.adapter,
          },
        );
      return {
        prepareAuthorizationBootstrapV1: (
          bootstrapInput: Parameters<typeof prepareAuthorizationBootstrapV1>[3],
        ) =>
          prepareAuthorizationBootstrapV1(
            input.db,
            input.taproot.options,
            input.taproot.hostAuthority,
            bootstrapInput,
          ),
        ownerParticipantIssuer,
        ownerAdapter,
        commitAuthorizationBootstrapV1,
        workshopSchemaVersion: 9,
      };
    },
  });
}

async function assembleExecutableDependencies(
  input: WorkshopLocalAssemblyPrimitivesV1,
  ownerHandles: WorkshopOwnerHandlesV1,
): Promise<WorkshopLocalExecutableDependenciesV1> {
  const guard = await createInstallationAuthorizationGuard(
    input.db,
    input.taproot.options,
    input.taproot.hostAuthority,
  );
  const authorization = createWorkshopAuthorizationAuthorityV1(input.db, guard);
  const cursorCodec = createWorkshopCursorCodecV1(input.cursor);
  const operator = await createTaprootWorkshopPortV1(
    input.db,
    input.taproot.options,
    input.taproot.hostAuthority,
    {
      installationId: input.installationId,
      ...(input.taproot.payloadStore
        ? { payloadStore: input.taproot.payloadStore }
        : {}),
      ...(input.taproot.maxHydratedResourceBytes === undefined
        ? {}
        : { maxHydratedResourceBytes: input.taproot.maxHydratedResourceBytes }),
    },
  );
  const registrationContext = await operator.resolveAuthorization(
    input.taproot.registrationPrincipal,
  );
  const search = await createWorkshopSearchIntegrationV1({
    db: input.db,
    taproot: input.taproot.options,
    hostCapability: input.taproot.hostAuthority,
    installationId: input.installationId,
    registrationContext,
  });
  const expectation: WorkshopProducerBindingExpectation = {
    installationId: input.installationId,
    connectionId: ownerHandles.owner.connectionId,
    registrationFingerprint: input.registrationFingerprint,
  };
  const producerBinding = bindWorkshopProducerHandles(expectation, {
    task: producerHandle(input, expectation, search.task),
    memory: producerHandle(input, expectation, search.memory),
    prompt: producerHandle(input, expectation, search.prompt),
  });
  const diamond = createWorkshopDiamondSparqlPortV1(input.db, input.diamond);
  const status = () =>
    workshopLocalStatus(
      input.db,
      guard,
      input,
      expectation,
      input.taproot.payloadStore !== undefined,
    );
  const workshop: WorkshopCoreOptions = {
    ...(input.workshop ?? {}),
    persistence: input.db,
    authorization,
    cursorCodec,
    search,
    diamondHealth: () => Promise.resolve(true),
    knowledge: {
      authorizedReader: (context) =>
        createAuthorizedTaproot(
          input.db,
          input.taproot.options,
          toTaprootContext(context),
          { cursorCodec: input.taproot.authorizationCursorCodec },
        ),
      health: async () => {
        await guard.readCurrentState();
        return true;
      },
    },
  };
  const dependencies: WorkshopLocalExecutableDependenciesV1 = {
    kind: 'workshop-local-executable-dependencies-v1' as const,
    version: input.version,
    workshop,
    taproot: {
      kind: 'workshop-taproot-assembly-v1' as const,
      db: input.db,
      installationId: input.installationId,
      taprootOptions: input.taproot.options,
      hostAuthority: input.taproot.hostAuthority,
      cursorCodec: input.taproot.authorizationCursorCodec,
      ...(input.taproot.payloadStore
        ? { payloadStore: input.taproot.payloadStore }
        : {}),
      ...(input.taproot.maxHydratedResourceBytes === undefined
        ? {}
        : { maxHydratedResourceBytes: input.taproot.maxHydratedResourceBytes }),
      status: async () => status(),
    },
    diamond,
    authentication: (config) => {
      if (config.authentication.profile !== 'local-bearer-v1')
        throw new WorkshopError(
          'dependency_unavailable',
          'The local assembly supports local-bearer-v1 authentication',
          503,
        );
      const credentials = createWorkshopLocalBearerCredentialStoreV1(input.db, {
        async resolve(identity) {
          if (identity.installationId !== input.installationId)
            throw forbidden();
          const live = await operator.resolveAuthorization({
            principalId: identity.principalId,
            activeWorkspaceId: identity.workspaceId,
          });
          return {
            capabilities: live.capabilities,
            authorizationRevision: live.authorizationRevision,
          };
        },
      });
      return Promise.resolve(
        createAuthenticationVerifier({
          profile: 'local-bearer-v1',
          credentials,
          authorization: {
            async recheck(principal, signal) {
              signal.throwIfAborted();
              const live = await operator.resolveAuthorization({
                principalId: principal.principalId,
                activeWorkspaceId: principal.activeWorkspaceId,
              });
              return { ...live, credentialId: principal.credentialId };
            },
          },
        }),
      );
    },
    producerBinding: { binding: producerBinding, expectation },
    preflight: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return status();
    },
    ...(input.assets ? { assets: input.assets } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    ownerHandles,
  };
  return Object.freeze(dependencies);
}

async function createLocalOwnerHandles(
  input: WorkshopLocalAssemblyPrimitivesV1,
): Promise<WorkshopOwnerHandlesV1> {
  const ledgerOwner = await registerMigrationLedgerOwnerV1({
    db: input.db,
    installationId: input.installationId,
    namespace: '@gnolith/workshop',
    migrations: workshopNamespacedMigrationsV1,
    assemblyAuthority: input.migrationAssemblyAuthority,
  });
  return createWorkshopOwnerHandlesV1({
    db: input.db,
    installationId: input.installationId,
    connectionId: ledgerOwner.connectionId,
    registrationFingerprint: input.registrationFingerprint,
    ledgerBackup: createMigrationLedgerBackupV1(
      input.db,
      input.migrationAssemblyAuthority,
    ),
    ledgerOwner,
  });
}

export function createWorkshopAuthorizationAuthorityV1(
  db: D1DatabaseLike,
  guard: InstallationAuthorizationGuard,
): WorkshopAuthorizationAuthority {
  const current = async (): Promise<InstallationAuthorizationState> => {
    const state = await guard.readCurrentState();
    return {
      installationId: state.installationId,
      authorizationRevision: state.authorizationRevision,
      searchGeneration: state.searchGeneration,
    };
  };
  const assertCurrent = async (
    context: AuthorizationContext,
    expected?: InstallationAuthorizationState,
  ): Promise<void> => {
    const state = await current();
    if (
      state.installationId !== context.installationId ||
      state.authorizationRevision !== context.authorizationRevision ||
      (expected &&
        (state.installationId !== expected.installationId ||
          state.authorizationRevision !== expected.authorizationRevision ||
          state.searchGeneration !== expected.searchGeneration))
    )
      throw forbidden();
  };
  const batch = async (
    context: AuthorizationContext,
    expected: InstallationAuthorizationState,
    mutations: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]> => {
    await assertCurrent(context, expected);
    const results = await db.batch([...mutations]);
    await assertCurrent(context, expected);
    return results;
  };
  const authority: WorkshopAuthorizationAuthority = {
    getInstallationAuthorizationState: current,
    async commitTaskMutation<T>(
      _db: D1DatabaseLike,
      context: AuthorizationContext,
      mutation: D1PreparedStatementLike,
    ) {
      await assertCurrent(context);
      const value = await mutation.first<T>();
      await assertCurrent(context);
      return value;
    },
    async commitMemoryMutation<T>(
      _db: D1DatabaseLike,
      context: AuthorizationContext,
      mutation: D1PreparedStatementLike,
    ) {
      await assertCurrent(context);
      const value = await mutation.first<T>();
      await assertCurrent(context);
      return value;
    },
    commitTaskBackfill: (_db, context, expected, mutations) =>
      batch(context, expected, mutations),
    commitMemoryBackfill: (_db, context, expected, mutations) =>
      batch(context, expected, mutations),
    commitCursorSnapshot: (_db, context, expected, mutations) =>
      batch(context, expected, mutations),
  };
  return Object.freeze(authority);
}

export function createWorkshopCursorCodecV1(
  secrets: WorkshopCursorSecretsV1,
): WorkshopCursorCodec {
  validateCursorSecrets(secrets);
  const codec: WorkshopCursorCodec = {
    currentGeneration: () => Promise.resolve(secrets.generation),
    async digest(purpose, value) {
      const prefix = new TextEncoder().encode(`${purpose}\u0000`);
      const material = new Uint8Array(prefix.length + value.length);
      material.set(prefix);
      material.set(value, prefix.length);
      return hex(
        new Uint8Array(
          await crypto.subtle.sign('HMAC', secrets.digestKey, material),
        ),
      );
    },
    async seal(generation, plaintext) {
      if (generation !== secrets.generation) throw forbidden();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          secrets.encryptionKey,
          plaintext as BufferSource,
        ),
      );
      return `wcv1.${generation}.${base64url(iv)}.${base64url(ciphertext)}`;
    },
    async open(generation, token) {
      const parts = token.split('.');
      if (
        parts.length !== 4 ||
        parts[0] !== 'wcv1' ||
        parts[1] !== generation ||
        generation !== secrets.generation
      )
        throw forbidden();
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: fromBase64url(parts[2]!) as BufferSource,
            },
            secrets.encryptionKey,
            fromBase64url(parts[3]!) as BufferSource,
          ),
        );
      } catch {
        throw forbidden();
      }
    },
  };
  return Object.freeze(codec);
}

export function createWorkshopDiamondSparqlPortV1(
  db: D1DatabaseLike,
  options: Omit<SparqlExecutorOptions, 'db' | 'sourceFactory'> = {},
): DiamondSparqlPort {
  const port: DiamondSparqlPort = {
    async validate(query) {
      const { ContextQueryValidator } = await import('./server/sparql.js');
      return new ContextQueryValidator().validate(query);
    },
    async query(scopedView, query, request) {
      const policy = scopedPolicy(scopedView);
      const allowed = new Set(policy.filter.allowedSubjectIris);
      if (request.dryRun)
        return {
          valid: true,
          dryRun: true,
          datasetId: policy.datasetId,
          allowedSubjectCount: allowed.size,
        };
      const execute = createSparqlExecutor({
        ...options,
        db,
        sourceFactory: (sourceDb, sourceOptions) =>
          scopedSource(new D1QuadSource(sourceDb, sourceOptions), allowed),
      });
      const response = await execute({
        operation: 'query',
        text: query,
        accept: 'application/sparql-results+json, application/n-quads',
        signal: request.signal,
      });
      const bytes = response.body
        ? new Uint8Array(await new Response(response.body).arrayBuffer())
        : new Uint8Array();
      const text = new TextDecoder().decode(bytes);
      return {
        status: response.status,
        mediaType: response.mediaType ?? 'application/octet-stream',
        data: parseResult(text, response.mediaType),
        byteLength: bytes.byteLength,
        ...(request.limit === undefined
          ? {}
          : { requestedLimit: request.limit }),
      };
    },
  };
  return Object.freeze(port);
}

function scopedSource(
  source: D1QuadSource,
  allowed: ReadonlySet<string>,
): RDF.Source {
  return {
    match(
      subject?: RDF.Term | null,
      predicate?: RDF.Term | null,
      object?: RDF.Term | null,
      graph?: RDF.Term | null,
    ) {
      if (subject?.termType === 'NamedNode' && !allowed.has(subject.value))
        return Readable.from([], {
          objectMode: true,
        }) as RDF.Stream<RDF.Quad>;
      const filter = new Transform({
        objectMode: true,
        transform(
          quad: RDF.Quad,
          _encoding: BufferEncoding,
          callback: TransformCallback,
        ) {
          callback(null, allowed.has(quad.subject.value) ? quad : undefined);
        },
      });
      const matches = source.match(
        subject,
        predicate,
        object,
        graph,
      ) as unknown as Readable;
      return matches.pipe(filter) as RDF.Stream<RDF.Quad>;
    },
  };
}

function scopedPolicy(value: unknown): {
  kind: 'taproot-scoped-sparql-policy-v1';
  datasetId: string;
  filter: {
    format: 'taproot-sparql-graph-filter-v1';
    allowedSubjectIris: readonly string[];
  };
} {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'taproot-scoped-sparql-policy-v1'
  )
    throw forbidden();
  return value as ReturnType<typeof scopedPolicy>;
}

async function workshopLocalStatus(
  db: D1DatabaseLike,
  guard: InstallationAuthorizationGuard,
  input: WorkshopLocalAssemblyPrimitivesV1,
  expectation: WorkshopProducerBindingExpectation,
  blobReady: boolean,
): Promise<WorkshopStatusSnapshot> {
  const [schema, state] = await Promise.all([
    db
      .prepare('SELECT version FROM workshop_schema WHERE singleton = 1')
      .first<{ version: number }>(),
    guard.readCurrentState(),
  ]);
  const authorizationReady =
    state.installationId === input.installationId &&
    state.authorizationRevision >= 1;
  return {
    baseIri: input.taproot.options.baseIri,
    migrations: {
      namespace: '@gnolith/workshop',
      version: schema?.version ?? 0,
      ready: schema?.version === 9,
    },
    compatibility: { diamond: true, taproot: true },
    canonicalReady: true,
    authorizationReady,
    lexicalReady: true,
    semantic: {
      state: 'unconfigured',
      configured: false,
    },
    producers: {
      ready: true,
      fingerprint: expectation.registrationFingerprint,
      kinds: ['task', 'memory', 'prompt'],
    },
    blobReady,
  };
}

function producerHandle(
  input: WorkshopLocalAssemblyPrimitivesV1,
  expectation: WorkshopProducerBindingExpectation,
  handle: unknown,
) {
  return {
    owner: '@gnolith/workshop' as const,
    installationId: input.installationId,
    connectionId: expectation.connectionId,
    registrationFingerprint: input.registrationFingerprint,
    handle,
  };
}

function toTaprootContext(
  context: AuthorizationContext,
): TaprootAuthorizationContext {
  return {
    installationId: context.installationId,
    principalId: context.principalId,
    activeWorkspaceId: context.activeWorkspaceId,
    workspaceIds: context.workspaceIds,
    capabilities: context.capabilities,
    authorizationRevision: context.authorizationRevision,
  };
}

function validateInput(input: WorkshopLocalAssemblyPrimitivesV1): void {
  if (
    input.kind !== 'workshop-local-assembly-primitives-v1' ||
    !input.version ||
    !input.installationId ||
    !/^[a-f0-9]{64}$/u.test(input.registrationFingerprint) ||
    !input.taproot.registrationPrincipal.principalId
  )
    throw new WorkshopError(
      'dependency_unavailable',
      'Workshop local assembly primitives are incomplete',
      503,
    );
}

function validateCursorSecrets(secrets: WorkshopCursorSecretsV1): void {
  if (
    !secrets.generation ||
    secrets.encryptionKey.extractable ||
    secrets.encryptionKey.algorithm.name !== 'AES-GCM' ||
    !secrets.encryptionKey.usages.includes('encrypt') ||
    !secrets.encryptionKey.usages.includes('decrypt') ||
    secrets.digestKey.extractable ||
    secrets.digestKey.algorithm.name !== 'HMAC' ||
    !secrets.digestKey.usages.includes('sign')
  )
    throw new WorkshopError(
      'dependency_unavailable',
      'Workshop cursor keys are incompatible',
      503,
    );
}

function parseResult(text: string, mediaType?: string): unknown {
  if (mediaType?.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new WorkshopError(
        'internal_error',
        'Diamond returned invalid JSON',
        500,
      );
    }
  }
  return text;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw forbidden();
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function forbidden(): WorkshopError {
  return new WorkshopError('forbidden', 'Authorization denied', 403);
}
