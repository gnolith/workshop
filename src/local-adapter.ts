import type { BootstrapWorkshopV1Dependencies } from './bootstrap.js';
import { createWorkshopDomainOperationPortV1 } from './domain-operation.js';
import type {
  ProtectedReader,
  WorkshopExecutableAdapter,
} from './executable.js';
import { createOperationRuntime } from './operations.js';
import type { WorkshopOwnerHandlesV1 } from './backup.js';
import { WorkshopError } from './protocol/errors.js';
import type { AuthenticationVerifier } from './server/auth.js';
import type { VerifiedWaystoneAssets } from './server/assets.js';
import type { WorkshopServiceConfig } from './server/config.js';
import {
  createWorkshopCore,
  type WorkshopCoreOptions,
} from './server/context.js';
import type { BoundedTriggerController } from './server/lifecycle.js';
import type { CloseableDependency } from './server/service.js';
import type {
  VerifiedWorkshopProducerBinding,
  WorkshopProducerBindingExpectation,
} from './producers.js';
import {
  createWorkshopTaprootOperationPortV1,
  type WorkshopTaprootAssemblyOptionsV1,
} from './taproot-operation.js';
import type {
  DiamondSparqlPort,
  WorkshopStatusSnapshot,
} from './operations.js';

export interface WorkshopLocalExecutableDependenciesV1 {
  kind: 'workshop-local-executable-dependencies-v1';
  version: string;
  workshop: WorkshopCoreOptions;
  taproot: WorkshopTaprootAssemblyOptionsV1;
  diamond: DiamondSparqlPort;
  authentication: (
    config: WorkshopServiceConfig,
    protectedReader: ProtectedReader,
  ) => Promise<AuthenticationVerifier>;
  producerBinding: {
    binding: VerifiedWorkshopProducerBinding;
    expectation: WorkshopProducerBindingExpectation;
  };
  preflight: (signal: AbortSignal) => Promise<WorkshopStatusSnapshot>;
  assets?: (
    config: WorkshopServiceConfig,
    protectedReader: ProtectedReader,
  ) => Promise<VerifiedWaystoneAssets | undefined>;
  trigger?: BoundedTriggerController;
  dependencies?: readonly CloseableDependency[];
  ownerHandles: WorkshopOwnerHandlesV1;
  bootstrap?: Omit<BootstrapWorkshopV1Dependencies, 'readProtectedCredential'>;
}

export interface WorkshopLocalExecutableAdapterV1 extends WorkshopExecutableAdapter {
  readonly kind: 'workshop-local-executable-adapter-v1';
  readonly ownerHandles: WorkshopOwnerHandlesV1;
}

/**
 * Sole Workshop-owned production assembly. Environment adapters may qualify
 * paths, secrets, and provider clients, but cannot alter catalog or dispatch.
 */
export async function createWorkshopLocalExecutableAdapterV1(
  dependencies: WorkshopLocalExecutableDependenciesV1,
): Promise<WorkshopLocalExecutableAdapterV1> {
  validateDependencies(dependencies);
  const core = createWorkshopCore(dependencies.workshop);
  const taproot = await createWorkshopTaprootOperationPortV1(
    dependencies.taproot,
  );
  const operations = createOperationRuntime({
    version: dependencies.version,
    taproot,
    diamond: dependencies.diamond,
    workshop: createWorkshopDomainOperationPortV1(core),
  });
  const adapter: WorkshopLocalExecutableAdapterV1 = {
    kind: 'workshop-local-executable-adapter-v1' as const,
    ownerHandles: dependencies.ownerHandles,
    async createWorkshopExecutable(config, protectedReader) {
      const authentication = await dependencies.authentication(
        config,
        protectedReader,
      );
      const assets = await dependencies.assets?.(config, protectedReader);
      return {
        version: dependencies.version,
        authentication,
        operations,
        producerBinding: dependencies.producerBinding,
        preflight: dependencies.preflight,
        ...(config.corsOrigins ? { corsOrigins: [...config.corsOrigins] } : {}),
        ...(assets ? { assets } : {}),
        ...(dependencies.trigger ? { trigger: dependencies.trigger } : {}),
        dependencies: [
          ...(dependencies.dependencies ?? []),
          ...(dependencies.diamond.close
            ? [{ close: () => dependencies.diamond.close?.() }]
            : []),
        ],
      };
    },
    ...(dependencies.bootstrap
      ? {
          createWorkshopBootstrapDependencies: () =>
            Promise.resolve(dependencies.bootstrap!),
        }
      : {}),
  };
  return Object.freeze(adapter);
}

export {
  createWorkshopAuthorizationAuthorityV1,
  createWorkshopCursorCodecV1,
  createWorkshopDiamondSparqlPortV1,
  createWorkshopLocalExecutableAdapterFromPrimitivesV1,
  createWorkshopLocalExecutableDependenciesV1,
  type WorkshopCursorSecretsV1,
  type WorkshopLocalAssemblyPrimitivesV1,
} from './local-dependencies.js';

function validateDependencies(
  dependencies: WorkshopLocalExecutableDependenciesV1,
): void {
  if (
    dependencies.kind !== 'workshop-local-executable-dependencies-v1' ||
    !dependencies.version ||
    dependencies.workshop.persistence !== dependencies.taproot.db ||
    typeof dependencies.authentication !== 'function' ||
    typeof dependencies.preflight !== 'function' ||
    !dependencies.workshop.search ||
    !dependencies.ownerHandles?.owner ||
    !dependencies.ownerHandles?.ledger
  )
    throw new WorkshopError(
      'dependency_unavailable',
      'Workshop local executable dependencies are incomplete or incompatible',
      503,
    );
}
