import { describe, expect, it } from 'vitest';
import {
  createAuthenticationVerifier,
  digestLocalBearerToken,
} from '../src/server/auth.js';
import { createWorkshopHttpService } from '../src/server/service.js';
import type { WorkshopStatusSnapshot } from '../src/operations.js';
import {
  CATALOG_DIGEST,
  operationCatalog,
} from '../src/generated/operations.js';
import { bindWorkshopProducerHandles } from '../src/producers.js';

const ready: WorkshopStatusSnapshot = {
  baseIri: 'https://example.invalid/',
  migrations: {
    namespace: '@gnolith/workshop',
    version: 9,
    ready: true,
  },
  compatibility: { diamond: true, taproot: true },
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  semantic: { state: 'ready', configured: true },
  producers: {
    ready: true,
    fingerprint: 'a'.repeat(64),
    kinds: ['task', 'memory', 'prompt'],
  },
  blobReady: true,
};
const producerExpectation = {
  installationId: 'installation:test',
  connectionId: 'connection:test',
  registrationFingerprint: 'a'.repeat(64),
};
const producerBinding = bindWorkshopProducerHandles(
  producerExpectation,
  Object.fromEntries(
    (['task', 'memory', 'prompt'] as const).map((publicKind) => [
      publicKind,
      {
        owner: '@gnolith/workshop' as const,
        ...producerExpectation,
        handle: { opaque: crypto.randomUUID() },
      },
    ]),
  ) as never,
);

describe('executable listener and authentication', () => {
  it('accepts only an exact local bearer and binds one ephemeral test listener', async () => {
    const tokenBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const token = Buffer.from(tokenBytes).toString('base64url');
    const digest = await digestLocalBearerToken(tokenBytes);
    const authentication = createAuthenticationVerifier({
      profile: 'local-bearer-v1',
      credentials: {
        async findByDigest(candidate) {
          return candidate === digest
            ? {
                profile: 'local-bearer-v1',
                credentialId: 'credential:test',
                tokenDigest: digest,
                installationId: 'installation:test',
                principalId: 'principal:test',
                activeWorkspaceId: 'workspace:test',
                capabilities: ['read'],
                authorizationRevision: 1,
                disabled: false,
              }
            : null;
        },
      },
      authorization: {
        async recheck(principal) {
          return principal;
        },
      },
    });
    await expect(
      authentication.authenticate(
        new Request(`https://example.invalid/mcp?access_token=${token}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    const service = createWorkshopHttpService({
      version: '0.5.0',
      listener: { host: '127.0.0.1', port: 0, profile: 'test' },
      authentication,
      producerBinding: {
        binding: producerBinding,
        expectation: producerExpectation,
      },
      operations: {
        catalog: operationCatalog,
        catalogDigest: CATALOG_DIGEST,
        async call() {
          return {};
        },
      },
      async preflight() {
        return ready;
      },
    });
    const address = await service.start();
    try {
      expect(address.port).toBeGreaterThan(0);
      const live = await fetch(`http://127.0.0.1:${address.port}/health/live`);
      expect(live.status).toBe(200);
      await expect(live.json()).resolves.toEqual({ status: 'live' });
    } finally {
      await service.stop();
    }
  });

  it('fails startup before binding when dependencies are not ready', async () => {
    const service = createWorkshopHttpService({
      version: '0.5.0',
      listener: { host: '127.0.0.1', port: 0, profile: 'test' },
      authentication: {
        profile: 'local-bearer-v1',
        challenge: 'Bearer',
        async authenticate() {
          throw new Error('unused');
        },
        protectedResourceMetadata: () => null,
      },
      producerBinding: {
        binding: producerBinding,
        expectation: producerExpectation,
      },
      operations: {
        catalog: operationCatalog,
        catalogDigest: CATALOG_DIGEST,
        async call() {
          return {};
        },
      },
      async preflight() {
        return { ...ready, canonicalReady: false };
      },
    });
    await expect(service.start()).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
  });
});
