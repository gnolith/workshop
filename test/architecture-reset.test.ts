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
    expect(operationCatalog).toHaveLength(51);
    expect(new Set(operationCatalog.map(({ name }) => name)).size).toBe(51);
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
    expect(body.result.tools).toHaveLength(51);
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
      schemaVersion: 8,
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
        schemaVersion: 8,
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
              version: 8,
              ready: true,
            },
            compatibility: { diamond: true, taproot: true },
            canonicalReady: true,
            authorizationReady: true,
            lexicalReady: true,
            semantic: { state: 'ready' as const, configured: true },
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
      migrationReadiness: { version: 8, ready: true },
      semanticState: { state: 'ready', configured: true },
      versions: { server: '0.5.0', operationSchema: 1 },
      operationCatalogDigest: CATALOG_DIGEST,
    });
  });
});
