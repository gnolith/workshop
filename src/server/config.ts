import { WorkshopError } from '../protocol/errors.js';
import type { RemoteOAuthConfig } from './auth.js';
import { validateWorkshopAssetPrefix } from './assets.js';

export interface ListenerConfig {
  host: string;
  port: number;
  profile: 'container' | 'remote' | 'test';
}

export interface ProtectedSelectorConfig {
  kind: 'file' | 'inherited-descriptor' | 'environment-selector';
  value: string | number;
}

export interface WorkshopServiceConfig {
  format: 'gnolith-workshop-config-v1';
  listener: ListenerConfig;
  authentication:
    | {
        profile: 'local-bearer-v1';
        credentialStore: ProtectedSelectorConfig;
      }
    | (RemoteOAuthConfig & {
        profile: 'remote-oauth-v1';
        metadata: ProtectedSelectorConfig;
      });
  adapterModule: string;
  corsOrigins?: readonly string[];
  apiPrefix?: '/api/v1';
  assetMount?: {
    prefix: string;
    manifest: ProtectedSelectorConfig;
    root: ProtectedSelectorConfig;
  };
  background?: {
    intervalMs: number;
    timeoutMs: number;
  };
  shutdownTimeoutMs?: number;
}

export function validateWorkshopServiceConfig(
  value: unknown,
): WorkshopServiceConfig {
  if (!isRecord(value) || value.format !== 'gnolith-workshop-config-v1')
    throw invalid('Configuration format is invalid');
  exactKeys(value, [
    'format',
    'listener',
    'authentication',
    'adapterModule',
    'corsOrigins',
    'apiPrefix',
    'assetMount',
    'background',
    'shutdownTimeoutMs',
  ]);
  const listener = validateListenerConfig(value.listener);
  if (!isRecord(value.authentication))
    throw invalid('Authentication configuration is required');
  const profile = value.authentication.profile;
  if (profile !== 'local-bearer-v1' && profile !== 'remote-oauth-v1')
    throw invalid('Authentication profile is invalid');
  if (
    typeof value.adapterModule !== 'string' ||
    !value.adapterModule ||
    value.adapterModule.includes('\u0000')
  )
    throw invalid('adapterModule is invalid');
  if (value.apiPrefix !== undefined && value.apiPrefix !== '/api/v1')
    throw invalid('apiPrefix is invalid');
  const corsOrigins = value.corsOrigins;
  if (
    corsOrigins !== undefined &&
    (!Array.isArray(corsOrigins) ||
      corsOrigins.some(
        (origin) =>
          typeof origin !== 'string' ||
          new URL(origin).origin !== origin ||
          !['https:', 'http:'].includes(new URL(origin).protocol),
      ))
  )
    throw invalid('CORS origins are invalid');
  const authentication =
    profile === 'local-bearer-v1'
      ? localAuthentication(value.authentication)
      : remoteAuthentication(value.authentication);
  const background = value.background;
  if (isRecord(background)) exactKeys(background, ['intervalMs', 'timeoutMs']);
  if (
    background !== undefined &&
    (!isRecord(background) ||
      !boundedInteger(background.intervalMs, 100, 86_400_000) ||
      !boundedInteger(background.timeoutMs, 1, 86_400_000) ||
      Number(background.timeoutMs) > Number(background.intervalMs))
  )
    throw invalid('Background trigger configuration is invalid');
  const shutdownTimeoutMs =
    value.shutdownTimeoutMs === undefined ? 30_000 : value.shutdownTimeoutMs;
  if (!boundedInteger(shutdownTimeoutMs, 1, 300_000))
    throw invalid('Shutdown timeout is invalid');
  const assetMount =
    value.assetMount === undefined
      ? undefined
      : validateAssetMount(value.assetMount);
  return {
    format: 'gnolith-workshop-config-v1',
    listener,
    authentication,
    adapterModule: value.adapterModule,
    ...(corsOrigins ? { corsOrigins: [...(corsOrigins as string[])] } : {}),
    apiPrefix: '/api/v1',
    ...(assetMount ? { assetMount } : {}),
    ...(background
      ? {
          background: {
            intervalMs: Number(background.intervalMs),
            timeoutMs: Number(background.timeoutMs),
          },
        }
      : {}),
    shutdownTimeoutMs: Number(shutdownTimeoutMs),
  };
}

export function validateListenerConfig(value: unknown): ListenerConfig {
  if (
    !isRecord(value) ||
    typeof value.host !== 'string' ||
    !value.host ||
    value.host.length > 255 ||
    !boundedInteger(value.port, 0, 65_535) ||
    !['container', 'remote', 'test'].includes(String(value.profile))
  )
    throw invalid('Listener configuration is invalid');
  exactKeys(value, ['host', 'port', 'profile']);
  const profile = value.profile as ListenerConfig['profile'];
  const host = value.host;
  const port = Number(value.port);
  if (profile === 'container' && (isLoopback(host) || port === 0))
    throw invalid(
      'Container profile requires an explicit non-loopback container-network bind',
    );
  if (profile === 'remote' && port === 0)
    throw invalid('Remote profile requires an explicit port');
  return { host, port, profile };
}

function localAuthentication(
  value: Record<string, unknown>,
): WorkshopServiceConfig['authentication'] {
  exactKeys(value, ['profile', 'credentialStore']);
  return {
    profile: 'local-bearer-v1',
    credentialStore: selector(value.credentialStore),
  };
}

function remoteAuthentication(
  value: Record<string, unknown>,
): WorkshopServiceConfig['authentication'] {
  const required = [
    'issuer',
    'audience',
    'resource',
    'principalClaim',
    'workspaceClaim',
    'installationClaim',
    'credentialClaim',
  ];
  if (required.some((key) => typeof value[key] !== 'string'))
    throw invalid('Remote OAuth configuration is invalid');
  if (!boundedInteger(value.maxClockSkewSeconds, 0, 300))
    throw invalid('Remote OAuth clock skew is invalid');
  exactKeys(value, [
    'profile',
    ...required,
    'algorithms',
    'requiredScopes',
    'authorizationServers',
    'scopeCapabilityMap',
    'maxClockSkewSeconds',
    'metadata',
  ]);
  return {
    profile: 'remote-oauth-v1',
    issuer: String(value.issuer),
    audience: String(value.audience),
    algorithms: stringArray(value.algorithms),
    requiredScopes: stringArray(value.requiredScopes),
    resource: String(value.resource),
    authorizationServers: stringArray(value.authorizationServers),
    scopeCapabilityMap: stringMap(value.scopeCapabilityMap),
    principalClaim: String(value.principalClaim),
    workspaceClaim: String(value.workspaceClaim),
    installationClaim: String(value.installationClaim),
    credentialClaim: String(value.credentialClaim),
    maxClockSkewSeconds: Number(value.maxClockSkewSeconds),
    metadata: selector(value.metadata),
  };
}

function validateAssetMount(
  value: unknown,
): NonNullable<WorkshopServiceConfig['assetMount']> {
  if (!isRecord(value) || typeof value.prefix !== 'string')
    throw invalid('Asset mount configuration is invalid');
  exactKeys(value, ['prefix', 'manifest', 'root']);
  return {
    prefix: validateWorkshopAssetPrefix(value.prefix),
    manifest: selector(value.manifest),
    root: selector(value.root),
  };
}

function selector(value: unknown): ProtectedSelectorConfig {
  if (
    !isRecord(value) ||
    !['file', 'inherited-descriptor', 'environment-selector'].includes(
      String(value.kind),
    ) ||
    (typeof value.value !== 'string' && typeof value.value !== 'number')
  )
    throw invalid('Protected selector is invalid');
  exactKeys(value, ['kind', 'value']);
  return {
    kind: value.kind as ProtectedSelectorConfig['kind'],
    value: value.value,
  };
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some(
      (entry) => typeof entry !== 'string' || !entry || entry.length > 4096,
    )
  )
    throw invalid('Expected a bounded nonempty string array');
  return [...new Set(value as string[])].sort();
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw invalid('Expected a string map');
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== 'string' || !entry)
      throw invalid('Expected a string map');
    output[key] = entry;
  }
  return output;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(host)
  );
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key)))
    throw invalid('Configuration contains unknown fields');
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
