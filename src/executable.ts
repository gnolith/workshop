import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  bootstrapWorkshopV1,
  type BootstrapWorkshopV1Dependencies,
  type BootstrapWorkshopV1Input,
  type ProtectedCredentialSelector,
} from './bootstrap.js';
import { WorkshopError } from './protocol/errors.js';
import {
  validateWorkshopServiceConfig,
  type ProtectedSelectorConfig,
  type WorkshopServiceConfig,
} from './server/config.js';
import {
  createWorkshopHttpService,
  type WorkshopHttpService,
  type WorkshopHttpServiceOptions,
} from './server/service.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PROTECTED_BYTES = 1024 * 1024;

export interface WorkshopExecutableAdapter {
  createWorkshopExecutable(
    config: WorkshopServiceConfig,
    protectedReader: ProtectedReader,
  ): Promise<
    Omit<WorkshopHttpServiceOptions, 'listener' | 'shutdownTimeoutMs'>
  >;
  createWorkshopBootstrapDependencies?(
    config: WorkshopServiceConfig,
    protectedReader: ProtectedReader,
  ): Promise<Omit<BootstrapWorkshopV1Dependencies, 'readProtectedCredential'>>;
}

export type ProtectedReader = (
  selector: ProtectedSelectorConfig,
) => Promise<Uint8Array>;

export async function loadWorkshopServiceConfig(
  path: string,
): Promise<WorkshopServiceConfig> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CONFIG_BYTES)
    throw invalid('Configuration file is too large');
  try {
    return validateWorkshopServiceConfig(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch (error) {
    if (error instanceof WorkshopError) throw error;
    throw invalid('Configuration file is not valid JSON');
  }
}

export async function assembleWorkshopExecutable(
  configPath: string,
): Promise<WorkshopHttpService> {
  const config = await loadWorkshopServiceConfig(configPath);
  const adapter = await loadAdapter(config.adapterModule, configPath);
  const options = await adapter.createWorkshopExecutable(
    config,
    readProtectedSelector,
  );
  return createWorkshopHttpService({
    ...options,
    listener: config.listener,
    ...(config.shutdownTimeoutMs
      ? { shutdownTimeoutMs: config.shutdownTimeoutMs }
      : {}),
  });
}

export async function runWorkshopBootstrap(
  configPath: string,
  input: BootstrapWorkshopV1Input,
): Promise<unknown> {
  const config = await loadWorkshopServiceConfig(configPath);
  const adapter = await loadAdapter(config.adapterModule, configPath);
  if (!adapter.createWorkshopBootstrapDependencies)
    throw invalid('Adapter does not support bootstrap-v1');
  const dependencies = await adapter.createWorkshopBootstrapDependencies(
    config,
    readProtectedSelector,
  );
  return bootstrapWorkshopV1(input, {
    ...dependencies,
    readProtectedCredential: (selector) => readProtectedSelector(selector),
  });
}

export async function readProtectedSelector(
  selector: ProtectedSelectorConfig | ProtectedCredentialSelector,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (selector.kind === 'file') {
    bytes = await readFile(String(selector.value));
  } else if (selector.kind === 'inherited-descriptor') {
    if (
      typeof selector.value !== 'number' ||
      !Number.isSafeInteger(selector.value) ||
      selector.value < 3
    )
      throw invalid('Inherited descriptor selector is invalid');
    bytes = readFileSync(selector.value);
  } else {
    if (
      typeof selector.value !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(selector.value)
    )
      throw invalid('Environment selector is invalid');
    const value = process.env[selector.value];
    if (value === undefined) throw invalid('Protected value is unavailable');
    if (value.startsWith('file:')) {
      const path = value.slice('file:'.length);
      if (!path) throw invalid('Protected file selector is invalid');
      bytes = await readFile(path);
    } else if (/^fd:[3-9][0-9]*$/u.test(value)) {
      bytes = readFileSync(Number(value.slice('fd:'.length)));
    } else {
      throw invalid(
        'Environment selector must identify a protected file or inherited descriptor',
      );
    }
  }
  if (bytes.byteLength > MAX_PROTECTED_BYTES) {
    bytes.fill(0);
    throw invalid('Protected value is too large');
  }
  return bytes;
}

async function loadAdapter(
  moduleSelector: string,
  configPath: string,
): Promise<WorkshopExecutableAdapter> {
  const url = moduleSelector.startsWith('file:')
    ? moduleSelector
    : new URL(moduleSelector, pathToFileURL(configPath)).href;
  const loaded = (await import(url)) as Partial<WorkshopExecutableAdapter>;
  if (typeof loaded.createWorkshopExecutable !== 'function')
    throw invalid('Adapter module does not expose the executable factory');
  return loaded as WorkshopExecutableAdapter;
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
