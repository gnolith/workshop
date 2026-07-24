import { describe, expect, it } from 'vitest';
import {
  createAuthenticationVerifier,
  digestLocalBearerToken,
} from '../src/server/auth.js';
import { connect } from 'node:net';
import {
  verifyWaystoneAssetMount,
  WORKSHOP_RECOMMENDED_ASSET_PREFIX,
} from '../src/server/assets.js';
import { validateWorkshopServiceConfig } from '../src/server/config.js';
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
    version: 11,
    ready: true,
  },
  compatibility: { diamond: true, taproot: true },
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  semantic: {
    state: 'ready',
    configured: true,
    revision: 1,
    fingerprint: 'd'.repeat(64),
    ready: true,
  },
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
  it('validates and serves an immutable /app mount without shadowing service routes', async () => {
    const indexBytes = new TextEncoder().encode(
      '<!doctype html><title>Waystone</title>',
    );
    const fileSha256 = await sha256(indexBytes);
    const unsignedManifest = {
      format: 'waystone-assets-v1' as const,
      files: [
        {
          path: 'index.html',
          sha256: fileSha256,
          bytes: indexBytes.byteLength,
          mediaType: 'text/html; charset=utf-8',
          immutable: true as const,
        },
      ],
      entrypoint: 'index.html',
    };
    const assets = await verifyWaystoneAssetMount({
      prefix: WORKSHOP_RECOMMENDED_ASSET_PREFIX,
      manifest: {
        ...unsignedManifest,
        manifestSha256: await sha256(
          new TextEncoder().encode(canonicalize(unsignedManifest)),
        ),
      },
      source: {
        async read(path) {
          return path === 'index.html'
            ? { bytes: indexBytes, symlink: false }
            : null;
        },
      },
    });
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
      assets,
      async preflight() {
        return ready;
      },
    });

    const app = await service.fetch(new Request('https://example.invalid/app'));
    expect(app.status).toBe(200);
    expect(app.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const appBody = await app.text();
    expect(appBody).toContain('Waystone');
    const slashApp = await service.fetch(
      new Request('https://example.invalid/app/'),
    );
    expect(slashApp.status).toBe(200);
    expect(slashApp.headers.get('content-type')).toBe(
      app.headers.get('content-type'),
    );
    expect(slashApp.headers.get('content-length')).toBe(
      app.headers.get('content-length'),
    );
    await expect(slashApp.text()).resolves.toBe(appBody);
    expect(
      (
        await service.fetch(
          new Request('https://example.invalid/app/%2e%2e/secret'),
        )
      ).status,
    ).toBe(404);
    expect(
      (await service.fetch(new Request('https://example.invalid/app/%E0%A4%A')))
        .status,
    ).toBe(404);
    expect(
      (await service.fetch(new Request('https://example.invalid/'))).status,
    ).toBe(404);
    expect(
      (await service.fetch(new Request('https://example.invalid/health/live')))
        .status,
    ).toBe(200);
    expect(
      (
        await service.fetch(
          new Request('https://example.invalid/mcp', { method: 'GET' }),
        )
      ).status,
    ).not.toBe(200);
    const address = await service.start();
    try {
      for (const target of [
        '/app/%2e%2e/mcp',
        '/app/%2E%2E/health/live',
        '/app/%252e%252e/mcp',
        '/app/%252E%252E/health/live',
        '/app/%2e%2E/health/live',
        '/app/../mcp',
        '/app%2f..%2fmcp',
        '/app/%5c..%5chealth/live',
      ]) {
        const response = await rawHttp(address.port, target);
        expect(response.statusLine, target).toContain(' 400 ');
        expect(response.body, target).toContain('bad_request');
      }
      expect(
        (await fetch(`http://127.0.0.1:${address.port}/health/live`)).status,
      ).toBe(200);
      expect(
        (
          await fetch(`http://127.0.0.1:${address.port}/mcp`, {
            method: 'GET',
          })
        ).status,
      ).not.toBe(200);
    } finally {
      await service.stop();
    }

    const baseConfig = {
      format: 'gnolith-workshop-config-v1',
      listener: { host: '127.0.0.1', port: 0, profile: 'test' },
      authentication: {
        profile: 'local-bearer-v1',
        credentialStore: { kind: 'file', value: 'credential.json' },
      },
      adapterModule: './adapter.mjs',
      assetMount: {
        prefix: '/app',
        manifest: { kind: 'file', value: 'manifest.json' },
        root: { kind: 'file', value: 'assets' },
      },
    };
    expect(validateWorkshopServiceConfig(baseConfig).assetMount?.prefix).toBe(
      '/app',
    );
    for (const prefix of [
      '/',
      '/mcp',
      '/health/assets',
      '/api',
      '/.well-known',
    ]) {
      expect(() =>
        validateWorkshopServiceConfig({
          ...baseConfig,
          assetMount: { ...baseConfig.assetMount, prefix },
        }),
      ).toThrow();
    }

    await expect(
      verifyWaystoneAssetMount({
        prefix: '/app',
        manifest: {
          ...unsignedManifest,
          manifestSha256: await sha256(
            new TextEncoder().encode(canonicalize(unsignedManifest)),
          ),
        },
        source: {
          async read() {
            return { bytes: indexBytes, symlink: true };
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

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

  it('admits a lexical backlog so the bounded trigger can restore readiness', async () => {
    let triggerStarted = false;
    const service = createWorkshopHttpService({
      version: '0.5.0',
      listener: { host: '127.0.0.1', port: 0, profile: 'test' },
      authentication: {
        profile: 'local-bearer-v1',
        challenge: 'Bearer',
        async authenticate() {
          return {
            profile: 'local-bearer-v1',
            credentialId: 'credential:test',
            installationId: 'installation:test',
            principalId: 'principal:test',
            activeWorkspaceId: 'workspace:test',
            capabilities: ['read'],
            authorizationRevision: 1,
          };
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
          return {
            migrationReadiness: ready.migrations,
            canonicalReady: ready.canonicalReady,
            authorizationReady: ready.authorizationReady,
            lexicalReady: false,
            producers: ready.producers,
            blobReady: ready.blobReady,
          } as never;
        },
      },
      trigger: {
        get running() {
          return triggerStarted;
        },
        start() {
          triggerStarted = true;
        },
        invoke: () => Promise.resolve(true),
        async stop() {
          triggerStarted = false;
        },
      },
      async preflight() {
        return { ...ready, lexicalReady: false };
      },
    });
    const address = await service.start();
    try {
      expect(address.port).toBeGreaterThan(0);
      expect(triggerStarted).toBe(true);
      const response = await fetch(
        `http://127.0.0.1:${address.port}/health/ready`,
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(503);
      expect(body).toMatchObject({
        lexicalReady: false,
      });
    } finally {
      await service.stop();
    }
  });
});

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

async function rawHttp(
  port: number,
  target: string,
): Promise<{ statusLine: string; body: string }> {
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let value = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      value += String(chunk);
    });
    socket.once('end', () => resolve(value));
    socket.once('connect', () => {
      socket.end(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
  });
  const separator = response.indexOf('\r\n\r\n');
  return {
    statusLine: response.slice(0, response.indexOf('\r\n')),
    body: separator < 0 ? '' : response.slice(separator + 4),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Buffer.from(digest).toString('hex');
}
