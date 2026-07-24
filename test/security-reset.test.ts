import { describe, expect, it, vi } from 'vitest';
import {
  createAuthenticationVerifier,
  digestLocalBearerToken,
} from '../src/server/auth.js';
import { createGnolithMcpServer } from '../src/mcp/server.js';
import {
  CATALOG_DIGEST,
  operationCatalog,
} from '../src/generated/operations.js';
import type { AuthenticatedPrincipal } from '../src/protocol.js';

const principal: AuthenticatedPrincipal = {
  installationId: 'installation:security',
  principalId: 'principal:security',
  activeWorkspaceId: 'workspace:security',
  capabilities: ['read'],
  authorizationRevision: 7,
  credentialId: 'credential:security',
};

describe('reset transport security', () => {
  it('keeps local bearer credentials header-only, exact, and live-rechecked', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const token = Buffer.from(bytes).toString('base64url');
    const tokenDigest = await digestLocalBearerToken(bytes);
    const recheck = vi.fn(async () => principal);
    const findByDigest = vi.fn(async (digest: string) =>
      digest === tokenDigest
        ? {
            profile: 'local-bearer-v1' as const,
            credentialId: principal.credentialId,
            tokenDigest,
            installationId: principal.installationId,
            principalId: principal.principalId,
            activeWorkspaceId: principal.activeWorkspaceId,
            capabilities: principal.capabilities,
            authorizationRevision: principal.authorizationRevision,
            disabled: false,
          }
        : null,
    );
    const verifier = createAuthenticationVerifier({
      profile: 'local-bearer-v1',
      credentials: { findByDigest },
      authorization: { recheck },
    });
    await expect(
      verifier.authenticate(
        new Request('https://gnolith.invalid/mcp', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toEqual(principal);
    expect(findByDigest).toHaveBeenCalledWith(
      tokenDigest,
      expect.any(AbortSignal),
    );
    expect(recheck).toHaveBeenCalledOnce();

    await expect(
      verifier.authenticate(
        new Request(`https://gnolith.invalid/mcp?access_token=${token}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      verifier.authenticate(
        new Request('https://gnolith.invalid/mcp', {
          headers: {
            authorization: `Bearer ${token}`,
            cookie: `token=${token}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('validates remote OAuth metadata, claims, scopes, and live principal state', async () => {
    const jwt = {
      verify: vi.fn(async () => ({
        header: { alg: 'ES256' },
        claims: {
          iss: 'https://issuer.invalid',
          aud: ['gnolith-api'],
          exp: 2_000_000_100,
          nbf: 1_999_999_900,
          scope: 'gnolith.read',
          installation: principal.installationId,
          subject: principal.principalId,
          workspace: principal.activeWorkspaceId,
          credential: principal.credentialId,
        },
      })),
    };
    const resolve = vi.fn(async () => principal);
    const recheck = vi.fn(async () => principal);
    const verifier = createAuthenticationVerifier({
      profile: 'remote-oauth-v1',
      config: {
        profile: 'remote-oauth-v1',
        issuer: 'https://issuer.invalid',
        audience: 'gnolith-api',
        algorithms: ['ES256'],
        requiredScopes: ['gnolith.read'],
        resource: 'https://gnolith.invalid/mcp',
        authorizationServers: ['https://issuer.invalid'],
        scopeCapabilityMap: { 'gnolith.read': 'read' },
        principalClaim: 'subject',
        workspaceClaim: 'workspace',
        installationClaim: 'installation',
        credentialClaim: 'credential',
        maxClockSkewSeconds: 30,
      },
      jwt,
      principals: { resolve },
      authorization: { recheck },
      clock: () => new Date(2_000_000_000 * 1000),
    });
    expect(verifier.protectedResourceMetadata()).toEqual({
      resource: 'https://gnolith.invalid/mcp',
      authorization_servers: ['https://issuer.invalid'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['gnolith.read'],
    });
    await expect(
      verifier.authenticate(
        new Request('https://gnolith.invalid/mcp', {
          headers: { authorization: 'Bearer signed.jwt.value' },
        }),
      ),
    ).resolves.toEqual(principal);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: principal.installationId,
        principalId: principal.principalId,
        capabilities: ['read'],
      }),
      expect.any(AbortSignal),
    );
    expect(recheck).toHaveBeenCalledOnce();
  });

  it('rejects disallowed origins, batches, oversized bodies, and GET SSE', async () => {
    const authenticate = vi.fn(async () => principal);
    const mcp = createGnolithMcpServer({
      version: '0.5.0',
      maxRequestBytes: 64,
      authenticate,
      operations: {
        catalog: operationCatalog,
        catalogDigest: CATALOG_DIGEST,
        async call() {
          return {};
        },
      },
    });
    const get = await mcp.handle(
      new Request('https://gnolith.invalid/mcp', { method: 'GET' }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');

    const foreign = await mcp.handle(
      rpcRequest('{}', { origin: 'https://attacker.invalid' }),
    );
    expect(foreign.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();

    const batch = await mcp.handle(
      rpcRequest(
        JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
      ),
    );
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });

    const oversized = await mcp.handle(
      rpcRequest(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        { 'content-length': '65' },
      ),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });
  });
});

function rpcRequest(
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Request {
  return new Request('https://gnolith.invalid/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body,
  });
}
