import type {
  SemanticConfigurationV1,
  SemanticSearchAdminV1,
} from '@gnolith/taproot/search';
import type { AuthorizationContext } from '@gnolith/taproot';
import { WorkshopError } from './protocol/errors.js';
import type { D1DatabaseLike } from './server/database.js';
import { digestWorkshopOperationRequest } from './server/idempotency.js';

export interface ConfigureWorkshopSemanticsV1Input {
  version: 1;
  expectedRevision: number;
  idempotencyKey: string;
  configuration: SemanticConfigurationV1;
}

export interface ConfigureWorkshopSemanticsV1Dependencies {
  db: D1DatabaseLike;
  installationId: string;
  semantic: SemanticSearchAdminV1;
  authorization: AuthorizationContext;
  clock?: () => Date;
}

export interface ConfigureWorkshopSemanticsV1Receipt {
  version: 1;
  configurationId: string;
  revision: number;
  fingerprint: string;
  state: string;
  ready: boolean;
  replayed: boolean;
}

export interface WorkshopSemanticStatusV1 {
  state: 'ready' | 'degraded' | 'unconfigured';
  configured: boolean;
  revision: number | null;
  fingerprint: string | null;
  ready: boolean;
  backend: 'sqlite' | 'qdrant' | null;
}

export async function configureWorkshopSemanticsV1(
  raw: ConfigureWorkshopSemanticsV1Input,
  dependencies: ConfigureWorkshopSemanticsV1Dependencies,
): Promise<ConfigureWorkshopSemanticsV1Receipt> {
  const input = exactInput(raw);
  if (
    dependencies.authorization.installationId !== dependencies.installationId ||
    !dependencies.authorization.capabilities.includes('search:admin')
  )
    throw forbidden();
  const requestDigest = await digestWorkshopOperationRequest({
    operation: 'semantic.configure',
    expectedRevision: input.expectedRevision,
    configuration: input.configuration,
  });
  const prior = await receipt(
    dependencies.db,
    dependencies.installationId,
    dependencies.authorization.principalId,
    input.idempotencyKey,
  );
  if (prior) {
    if (prior.request_digest !== requestDigest) throw conflict();
    return { ...parseReceipt(prior.response_json), replayed: true };
  }
  try {
    await dependencies.semantic.configure(
      input.configuration,
      {
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      },
      dependencies.authorization,
    );
    await dependencies.semantic.select(
      input.configuration.id,
      dependencies.authorization,
    );
  } catch (error) {
    mapSemanticError(error);
  }
  const status = await dependencies.semantic.status(dependencies.authorization);
  if (
    status.revision === null ||
    status.fingerprint === null ||
    !/^[a-f0-9]{64}$/u.test(status.fingerprint)
  )
    throw new WorkshopError(
      'dependency_unavailable',
      'Semantic configuration status is incomplete',
      503,
    );
  const response: ConfigureWorkshopSemanticsV1Receipt = {
    version: 1,
    configurationId: input.configuration.id,
    revision: status.revision,
    fingerprint: status.fingerprint,
    state: status.state,
    ready: status.ready,
    replayed: false,
  };
  const now = (dependencies.clock ?? (() => new Date()))().toISOString();
  try {
    await dependencies.db.batch([
      dependencies.db
        .prepare(
          `INSERT INTO workshop_semantic_configuration_state (
             installation_id, revision, fingerprint, configuration_json,
             ready, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             revision = excluded.revision,
             fingerprint = excluded.fingerprint,
             configuration_json = excluded.configuration_json,
             ready = excluded.ready,
             updated_at = excluded.updated_at`,
        )
        .bind(
          dependencies.installationId,
          response.revision,
          response.fingerprint,
          JSON.stringify(input.configuration),
          response.ready ? 1 : 0,
          now,
        ),
      dependencies.db
        .prepare(
          `INSERT INTO workshop_semantic_configuration_receipts (
             installation_id, actor_principal_id, idempotency_key,
             request_digest, response_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          dependencies.installationId,
          dependencies.authorization.principalId,
          input.idempotencyKey,
          requestDigest,
          JSON.stringify(response),
          now,
        ),
    ]);
  } catch (error) {
    const concurrent = await receipt(
      dependencies.db,
      dependencies.installationId,
      dependencies.authorization.principalId,
      input.idempotencyKey,
    );
    if (!concurrent || concurrent.request_digest !== requestDigest) throw error;
    return { ...parseReceipt(concurrent.response_json), replayed: true };
  }
  return response;
}

export async function readWorkshopSemanticStatusV1(
  db: D1DatabaseLike,
  installationId: string,
): Promise<WorkshopSemanticStatusV1> {
  const row = await db
    .prepare(
      `SELECT revision, fingerprint, ready, configuration_json
       FROM workshop_semantic_configuration_state
       WHERE installation_id = ?`,
    )
    .bind(installationId)
    .first<{
      revision: number;
      fingerprint: string;
      ready: number;
      configuration_json: string;
    }>();
  if (!row)
    return {
      state: 'unconfigured',
      configured: false,
      revision: null,
      fingerprint: null,
      ready: false,
      backend: null,
    };
  return {
    state: row.ready === 1 ? 'ready' : 'degraded',
    configured: true,
    revision: Number(row.revision),
    fingerprint: row.fingerprint,
    ready: row.ready === 1,
    backend: semanticBackend(row.configuration_json),
  };
}

function semanticBackend(value: string): 'sqlite' | 'qdrant' {
  try {
    const parsed = JSON.parse(value) as { vector?: { kind?: unknown } };
    if (parsed.vector?.kind === 'sqlite' || parsed.vector?.kind === 'qdrant')
      return parsed.vector.kind;
  } catch {
    // Fail closed below without returning persisted configuration content.
  }
  throw new WorkshopError(
    'internal_error',
    'Semantic configuration status is invalid',
    500,
  );
}

function exactInput(
  value: ConfigureWorkshopSemanticsV1Input,
): ConfigureWorkshopSemanticsV1Input {
  const input = object(value);
  exactKeys(input, [
    'configuration',
    'expectedRevision',
    'idempotencyKey',
    'version',
  ]);
  if (input.version !== 1)
    throw invalid('Semantic configuration version is invalid');
  const expectedRevision = integer(input.expectedRevision, true);
  const idempotencyKey = identifier(input.idempotencyKey);
  const configuration = semanticConfiguration(input.configuration);
  return { version: 1, expectedRevision, idempotencyKey, configuration };
}

function semanticConfiguration(value: unknown): SemanticConfigurationV1 {
  const configuration = object(value);
  exactKeys(configuration, ['id', 'name', 'provider', 'vector', 'version']);
  if (configuration.version !== 1)
    throw invalid('Semantic configuration version is invalid');
  const provider = object(configuration.provider);
  exactKeys(provider, [
    'allowPrivateEndpoint',
    'credentialSelector',
    'dimensions',
    'endpoint',
    'kind',
    'metric',
    'model',
    'redirectPolicy',
  ]);
  if (
    provider.kind !== 'openai-compatible' &&
    provider.kind !== 'ollama-compatible'
  )
    throw invalid('Semantic provider profile is invalid');
  const allowPrivateEndpoint = boolean(provider.allowPrivateEndpoint);
  const providerEndpoint = fullSemanticProviderEndpoint(
    provider.kind,
    endpoint(provider.endpoint, allowPrivateEndpoint),
  );
  const model = identifier(provider.model, 512);
  const dimensions = integer(provider.dimensions);
  if (dimensions > 65_536)
    throw invalid('Semantic embedding dimensions are invalid');
  if (!['cosine', 'dot', 'euclid'].includes(String(provider.metric)))
    throw invalid('Semantic vector metric is invalid');
  if (provider.redirectPolicy !== 'error')
    throw invalid('Semantic redirect policy must fail closed');
  const credentialSelector = selector(provider.credentialSelector);
  const vector = object(configuration.vector);
  if (vector.kind === 'sqlite') {
    exactKeys(vector, ['kind']);
    return {
      version: 1,
      id: identifier(configuration.id),
      name: text(configuration.name, 1024),
      provider: {
        kind: provider.kind,
        endpoint: providerEndpoint,
        model,
        dimensions,
        metric: provider.metric as 'cosine' | 'dot' | 'euclid',
        credentialSelector,
        allowPrivateEndpoint,
        redirectPolicy: 'error',
      },
      vector: { kind: 'sqlite' },
    };
  }
  exactKeys(vector, [
    'allowPrivateEndpoint',
    'collection',
    'credentialSelector',
    'endpoint',
    'kind',
    'redirectPolicy',
  ]);
  if (vector.kind !== 'qdrant' || vector.redirectPolicy !== 'error')
    throw invalid('Semantic vector profile is invalid');
  const vectorPrivate = boolean(vector.allowPrivateEndpoint);
  return {
    version: 1,
    id: identifier(configuration.id),
    name: text(configuration.name, 1024),
    provider: {
      kind: provider.kind,
      endpoint: providerEndpoint,
      model,
      dimensions,
      metric: provider.metric as 'cosine' | 'dot' | 'euclid',
      credentialSelector,
      allowPrivateEndpoint,
      redirectPolicy: 'error',
    },
    vector: {
      kind: 'qdrant',
      endpoint: endpoint(vector.endpoint, vectorPrivate),
      collection: identifier(vector.collection, 256),
      credentialSelector: selector(vector.credentialSelector),
      allowPrivateEndpoint: vectorPrivate,
      redirectPolicy: 'error',
    },
  };
}

async function receipt(
  db: D1DatabaseLike,
  installationId: string,
  principalId: string,
  idempotencyKey: string,
) {
  return db
    .prepare(
      `SELECT request_digest, response_json
       FROM workshop_semantic_configuration_receipts
       WHERE installation_id = ? AND actor_principal_id = ?
         AND idempotency_key = ?`,
    )
    .bind(installationId, principalId, idempotencyKey)
    .first<{ request_digest: string; response_json: string }>();
}

function parseReceipt(value: string): ConfigureWorkshopSemanticsV1Receipt {
  try {
    return JSON.parse(value) as ConfigureWorkshopSemanticsV1Receipt;
  } catch {
    throw new WorkshopError(
      'internal_error',
      'Semantic configuration receipt is invalid',
      500,
    );
  }
}

function mapSemanticError(error: unknown): never {
  const candidate = error as { name?: unknown; code?: unknown };
  if (
    candidate?.name === 'AuthorizationDeniedError' ||
    candidate?.code === 'AUTHORIZATION_DENIED'
  )
    throw forbidden();
  if (
    candidate?.name === 'RevisionConflictError' ||
    candidate?.code === 'REVISION_CONFLICT'
  )
    throw conflict();
  if (
    candidate?.name === 'TypeError' ||
    candidate?.code === 'INVALID_CONFIGURATION'
  )
    throw invalid('Semantic configuration is invalid');
  if (error instanceof WorkshopError) throw error;
  throw new WorkshopError(
    'dependency_unavailable',
    'Semantic configuration failed',
    503,
  );
}

function endpoint(value: unknown, allowPrivate: boolean): string {
  const raw = text(value, 4096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('Semantic endpoint is invalid');
  }
  if (
    parsed.username ||
    parsed.password ||
    !['https:', ...(allowPrivate ? ['http:'] : [])].includes(parsed.protocol)
  )
    throw invalid('Semantic endpoint is invalid');
  if (
    !allowPrivate &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname.endsWith('.localhost') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.)/u.test(parsed.hostname) ||
      parsed.hostname === '::1')
  )
    throw invalid('Private semantic endpoint requires explicit approval');
  return parsed.href;
}

function fullSemanticProviderEndpoint(
  kind: 'openai-compatible' | 'ollama-compatible',
  endpointValue: string,
): string {
  const parsed = new URL(endpointValue);
  const terminal = kind === 'openai-compatible' ? '/embeddings' : '/api/embed';
  if (
    parsed.pathname.replace(/\/+$/u, '') !== terminal &&
    !parsed.pathname.replace(/\/+$/u, '').endsWith(terminal)
  )
    throw invalid(
      `Semantic ${kind} endpoint must be the exact ${terminal} POST URL`,
    );
  if (parsed.search || parsed.hash)
    throw invalid(
      'Semantic provider endpoint cannot contain query or fragment',
    );
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.href;
}

function selector(value: unknown): string | null {
  return value === null ? null : identifier(value, 256);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('Expected an object');
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  )
    throw invalid('Semantic configuration has unknown or missing fields');
}

function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    value.includes('\u0000')
  )
    throw invalid('Expected bounded text');
  return value;
}

function identifier(value: unknown, limit = 256): string {
  const result = text(value, limit);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(result))
    throw invalid('Semantic selector or identifier is invalid');
  return result;
}

function integer(value: unknown, zero = false): number {
  const minimum = zero ? 0 : 1;
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw invalid('Expected a bounded integer');
  return Number(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('Expected a boolean');
  return value;
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}

function forbidden(): WorkshopError {
  return new WorkshopError('forbidden', 'Authorization denied', 403);
}

function conflict(): WorkshopError {
  return new WorkshopError(
    'conflict',
    'Semantic configuration revision or idempotency key conflicts',
    409,
  );
}
