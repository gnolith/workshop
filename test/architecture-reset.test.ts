import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_DIGEST,
  operationCatalog,
} from '../src/generated/operations.js';
import { createGnolithMcpServer } from '../src/mcp/server.js';
import { WORKSHOP_SEARCH_KINDS } from '../src/protocol/catalog.js';
import type { AuthenticatedPrincipal } from '../src/protocol.js';
import { WorkshopError } from '../src/protocol/errors.js';
import {
  assertVerifiedWorkshopProducerBinding,
  bindWorkshopProducerHandles,
} from '../src/producers.js';
import { createWorkshopBackupApi } from '../src/backup.js';
import { createOperationRuntime } from '../src/operations.js';

type FixtureValidator = ((value: unknown) => boolean) & {
  errors?: unknown;
};
const AjvConstructor = createRequire(import.meta.url)('ajv') as new (options: {
  strict: boolean;
}) => {
  compile(schema: unknown): FixtureValidator;
};

const principal: AuthenticatedPrincipal = {
  installationId: 'installation:test',
  principalId: 'principal:test',
  credentialId: 'credential:test',
  activeWorkspaceId: 'workspace:test',
  capabilities: ['read'],
  authorizationRevision: 1,
};

describe('architecture reset contract', () => {
  it('publishes one exact operation registry and seven search kinds', () => {
    expect(operationCatalog).toHaveLength(52);
    expect(new Set(operationCatalog.map(({ name }) => name)).size).toBe(52);
    expect(CATALOG_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(WORKSHOP_SEARCH_KINDS).toEqual([
      'statement',
      'item',
      'task',
      'memory',
      'prompt',
      'resource',
      'annotation',
    ]);
    expect(operationCatalog.map(({ name }) => name)).not.toContain(
      'workshop_status',
    );
    const status = operationCatalog.find(
      ({ name }) => name === 'gnolith_status',
    )!;
    const statusSchema = status.outputSchema as {
      additionalProperties: boolean;
      required?: readonly string[];
    };
    expect(statusSchema.additionalProperties).toBe(false);
    expect(statusSchema.required).toContain('operationCatalogDigest');
    expect(statusSchema.required).toContain('semanticState');
  });

  it('authenticates before initialize or tool-catalog disclosure', async () => {
    let authenticated = false;
    const mcp = createGnolithMcpServer({
      version: '0.5.0',
      operations: {
        catalog: operationCatalog,
        catalogDigest: CATALOG_DIGEST,
        async call() {
          return {};
        },
      },
      async authenticate(request) {
        if (request.headers.get('authorization') !== 'Bearer accepted')
          throw new WorkshopError(
            'unauthenticated',
            'Authentication is required',
            401,
          );
        authenticated = true;
        return principal;
      },
    });
    const request = (authorization?: string) =>
      new Request('https://gnolith.example/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
    const denied = await mcp.handle(request());
    expect(denied.status).toBe(401);
    expect(authenticated).toBe(false);
    expect(await denied.text()).not.toContain('gnolith_status');

    const allowed = await mcp.handle(request('Bearer accepted'));
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools).toHaveLength(52);
    expect(body.result.tools[0]?.name).toBe('gnolith_status');
  });

  it('rejects structurally forged producer bindings', () => {
    const expectation = {
      installationId: 'installation:test',
      connectionId: 'connection:test',
      registrationFingerprint: 'a'.repeat(64),
    };
    const binding = bindWorkshopProducerHandles(
      expectation,
      Object.fromEntries(
        (['task', 'memory', 'prompt'] as const).map((publicKind) => [
          publicKind,
          {
            owner: '@gnolith/workshop' as const,
            ...expectation,
            handle: Object.freeze({ opaque: crypto.randomUUID() }),
          },
        ]),
      ) as never,
    );
    expect(() =>
      assertVerifiedWorkshopProducerBinding(binding, expectation),
    ).not.toThrow();
    expect(() =>
      assertVerifiedWorkshopProducerBinding({ ...binding }, expectation),
    ).toThrow(/not verified/u);
  });

  it('keeps backup ownership bound and expires imported leases', async () => {
    const imports: Array<Record<string, unknown>> = [];
    const owner = {
      owner: '@gnolith/workshop' as const,
      connectionId: 'connection:test',
      registrationFingerprint: 'b'.repeat(64),
      async exportOwnedState() {
        return { rows: [] };
      },
      async inspectOwnedState() {
        return {
          taskCount: 2,
          memoryCount: 1,
          promptCount: 3,
          onboarding: { retained: 4, migrated: 0, deferred: 0 },
        };
      },
      async importOwnedState(input: Record<string, unknown>) {
        imports.push(input);
      },
    };
    const ledger = {
      connectionId: owner.connectionId,
      registrationFingerprint: owner.registrationFingerprint,
      async exportOwnedSlice() {
        return { migrations: [] };
      },
      async inspectOwnedSlice() {},
      async importOwnedSlice(input: Record<string, unknown>) {
        imports.push(input);
      },
    };
    const api = createWorkshopBackupApi({
      owner,
      ledger,
      schemaVersion: 11,
      clock: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    const backup = await api.exportBackup('installation:test');
    await expect(api.inspectBackup(backup)).resolves.toMatchObject({
      valid: true,
      legacy: { taskCount: 2, memoryCount: 1, promptCount: 3 },
    });
    await api.importBackup(backup);
    expect(imports[0]).toMatchObject({
      expireTaskLeasesAt: '2026-07-23T12:00:00.000Z',
    });
    expect(() =>
      createWorkshopBackupApi({
        owner,
        ledger: { ...ledger, connectionId: 'forged' },
        schemaVersion: 11,
      }),
    ).toThrow(/binding/u);
  });

  it('returns the schema-identical nested readiness evidence', async () => {
    const runtime = createOperationRuntime({
      version: '0.5.0',
      taproot: {
        async call() {
          return {};
        },
        async createScopedSparqlView() {
          return {};
        },
        async recheckPrincipal() {
          return principal;
        },
        async status() {
          return {
            baseIri: 'https://example.invalid/',
            migrations: {
              namespace: '@gnolith/workshop' as const,
              version: 11,
              ready: true,
            },
            compatibility: { diamond: true, taproot: true },
            canonicalReady: true,
            authorizationReady: true,
            lexicalReady: true,
            semantic: {
              state: 'ready' as const,
              configured: true,
              revision: 1,
              fingerprint: 'd'.repeat(64),
              ready: true,
              diagnostic: null,
            },
            producers: {
              ready: true,
              fingerprint: 'c'.repeat(64),
              kinds: ['task', 'memory', 'prompt'] as const,
            },
            blobReady: true,
          };
        },
      },
      diamond: {
        async validate() {
          return {};
        },
        async query() {
          return {};
        },
      },
      workshop: {
        async call() {
          return {};
        },
      },
    });
    await expect(
      runtime.call(
        'gnolith_status',
        {},
        {
          principal,
          requestId: 'request:test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      installationId: principal.installationId,
      principalId: principal.principalId,
      migrationReadiness: { version: 11, ready: true },
      semanticState: {
        state: 'ready',
        configured: true,
        revision: 1,
        fingerprint: 'd'.repeat(64),
        ready: true,
      },
      versions: { server: '0.5.0', operationSchema: 2 },
      operationCatalogDigest: CATALOG_DIGEST,
    });
  });

  it('publishes versioned bounded Alembic-facing status evidence fixtures', () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          '../schemas/fixtures/workshop-status-evidence-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      format: string;
      version: number;
      operationSchemaVersion: number;
      fixtures: Record<string, Record<string, unknown>>;
    };
    expect(artifact).toMatchObject({
      format: 'gnolith-workshop-status-evidence-fixtures-v1',
      version: 1,
      operationSchemaVersion: 2,
    });
    const status = operationCatalog.find(
      ({ name }) => name === 'gnolith_status',
    );
    expect(status).toBeDefined();
    const validate = new AjvConstructor({
      strict: false,
    }).compile(status!.outputSchema);
    for (const [name, fixture] of Object.entries(artifact.fixtures))
      expect(
        validate(fixture),
        `${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    expect(
      artifact.fixtures.materializationPendingSqlite?.semanticState,
    ).toMatchObject({
      diagnostic: {
        format: 'gnolith-workshop-semantic-diagnostic-v1',
        version: 1,
        code: 'materialization-pending',
        retryable: true,
        backend: 'sqlite',
        repair: 'retry',
      },
    });
    expect(
      artifact.fixtures.providerUnavailableQdrant?.semanticState,
    ).toMatchObject({
      diagnostic: {
        code: 'provider-unavailable',
        retryable: true,
        backend: 'qdrant',
      },
    });
    expect(artifact.fixtures.ready?.semanticState).toMatchObject({
      state: 'ready',
      ready: true,
      diagnostic: null,
    });
    expect(
      artifact.fixtures.providerUnavailableAfterRestart?.semanticState,
    ).toMatchObject({
      state: 'degraded',
      ready: false,
      diagnostic: {
        code: 'provider-unavailable',
        retryable: true,
        backend: 'sqlite',
      },
    });
    const pending = artifact.fixtures.materializationPendingSqlite!;
    for (const mutate of [
      (value: Record<string, unknown>) => {
        (
          (value.semanticState as Record<string, unknown>).diagnostic as Record<
            string,
            unknown
          >
        ).secret = 'must-not-appear';
      },
      (value: Record<string, unknown>) => {
        (
          (value.semanticState as Record<string, unknown>).diagnostic as Record<
            string,
            unknown
          >
        ).backend = 'remote-url';
      },
      (value: Record<string, unknown>) => {
        (
          (value.semanticState as Record<string, unknown>).diagnostic as Record<
            string,
            unknown
          >
        ).retryable = 'yes';
      },
      (value: Record<string, unknown>) => {
        (
          (value.semanticState as Record<string, unknown>).diagnostic as Record<
            string,
            unknown
          >
        ).cause = { message: 'recursive detail' };
      },
      (value: Record<string, unknown>) => {
        (
          (value.semanticState as Record<string, unknown>).diagnostic as Record<
            string,
            unknown
          >
        ).code = 'x'.repeat(4097);
      },
    ]) {
      const invalid = structuredClone(pending);
      mutate(invalid);
      expect(validate(invalid)).toBe(false);
    }
  });

  it('rejects malformed entity commands before Taproot dispatch', async () => {
    let dispatched = 0;
    const runtime = createOperationRuntime({
      version: '0.5.0',
      taproot: {
        async call() {
          dispatched += 1;
          return {};
        },
        async createScopedSparqlView() {
          return {};
        },
        async recheckPrincipal() {
          return principal;
        },
        async status() {
          throw new Error('unused');
        },
      },
      diamond: {
        async validate() {
          return {};
        },
        async query() {
          return {};
        },
      },
      workshop: {
        async call() {
          return {};
        },
      },
    });
    await expect(
      runtime.call(
        'mutate_entity',
        {
          entityId: 'Q1',
          expectedRevision: 1,
          idempotencyKey: 'invalid-statement',
          mutations: [
            {
              kind: 'statement',
              authoredText: 'Malformed statement must not commit.',
              value: { type: 'add-statement', statement: {} },
            },
          ],
        },
        {
          principal,
          requestId: 'request:invalid-statement',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
    });
    expect(dispatched).toBe(0);
  });
});
