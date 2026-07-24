import { WorkshopError } from '../protocol/errors.js';
import type { AuthenticatedPrincipal } from '../protocol.js';
import type { D1DatabaseLike } from './database.js';

const LOCAL_PREFIX = new TextEncoder().encode('gnolith-local-bearer-v1\u0000');
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_AUTHORIZATION_HEADER = 16_512;
const MAX_OAUTH_TOKEN = 16_384;

export interface LocalBearerCredentialRecord {
  profile: 'local-bearer-v1';
  credentialId: string;
  tokenDigest: string;
  installationId: string;
  principalId: string;
  activeWorkspaceId: string | null;
  capabilities: readonly string[];
  authorizationRevision: number;
  disabled: boolean;
}

export interface LocalBearerCredentialStore {
  findByDigest(
    digest: string,
    signal: AbortSignal,
  ): Promise<LocalBearerCredentialRecord | null>;
}

export interface LocalBearerAuthorizationResolverV1 {
  resolve(input: {
    installationId: string;
    principalId: string;
    workspaceId: string;
    signal: AbortSignal;
  }): Promise<{
    capabilities: readonly string[];
    authorizationRevision: number;
  }>;
}

/** Reads only Workshop's schema-v8 credential table. */
export function createWorkshopLocalBearerCredentialStoreV1(
  db: D1DatabaseLike,
  authorization: LocalBearerAuthorizationResolverV1,
): LocalBearerCredentialStore {
  return {
    async findByDigest(digest, signal) {
      if (signal.aborted) throw signal.reason;
      if (!/^[a-f0-9]{64}$/u.test(digest)) return null;
      const row = await db
        .prepare(
          `SELECT installation_id, credential_id, token_digest, principal_id,
                  workspace_id, disabled
           FROM workshop_credentials
           WHERE token_digest = ?`,
        )
        .bind(digest)
        .first<{
          installation_id: string;
          credential_id: string;
          token_digest: string;
          principal_id: string;
          workspace_id: string;
          disabled: number;
        }>();
      if (!row) return null;
      const resolved = await authorization.resolve({
        installationId: row.installation_id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        signal,
      });
      return {
        profile: 'local-bearer-v1',
        credentialId: row.credential_id,
        tokenDigest: row.token_digest,
        installationId: row.installation_id,
        principalId: row.principal_id,
        activeWorkspaceId: row.workspace_id,
        capabilities: [...resolved.capabilities],
        authorizationRevision: resolved.authorizationRevision,
        disabled: row.disabled !== 0,
      };
    },
  };
}

export interface AuthorizationFence {
  recheck(
    principal: AuthenticatedPrincipal,
    signal: AbortSignal,
  ): Promise<AuthenticatedPrincipal>;
}

export interface LocalBearerAuthOptions {
  profile: 'local-bearer-v1';
  credentials: LocalBearerCredentialStore;
  authorization: AuthorizationFence;
}

export interface RemoteOAuthConfig {
  profile: 'remote-oauth-v1';
  issuer: string;
  audience: string;
  algorithms: readonly string[];
  requiredScopes: readonly string[];
  resource: string;
  authorizationServers: readonly string[];
  scopeCapabilityMap: Readonly<Record<string, string>>;
  principalClaim: string;
  workspaceClaim: string;
  installationClaim: string;
  credentialClaim: string;
  maxClockSkewSeconds: number;
}

export interface VerifiedJwt {
  header: Readonly<Record<string, unknown>>;
  claims: Readonly<Record<string, unknown>>;
}

export interface RemoteJwtVerifier {
  verify(
    token: string,
    config: RemoteOAuthConfig,
    signal: AbortSignal,
  ): Promise<VerifiedJwt>;
}

export interface RemotePrincipalResolver {
  resolve(
    identity: {
      installationId: string;
      principalId: string;
      activeWorkspaceId: string | null;
      credentialId: string;
      scopes: readonly string[];
      capabilities: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<AuthenticatedPrincipal>;
}

export interface RemoteOAuthAuthOptions {
  profile: 'remote-oauth-v1';
  config: RemoteOAuthConfig;
  jwt: RemoteJwtVerifier;
  principals: RemotePrincipalResolver;
  authorization: AuthorizationFence;
  clock?: () => Date;
}

export type AuthenticationOptions =
  LocalBearerAuthOptions | RemoteOAuthAuthOptions;

export interface AuthenticationVerifier {
  readonly profile: AuthenticationOptions['profile'];
  readonly challenge: string;
  authenticate(request: Request): Promise<AuthenticatedPrincipal>;
  protectedResourceMetadata(): Record<string, unknown> | null;
}

export function createAuthenticationVerifier(
  options: AuthenticationOptions,
): AuthenticationVerifier {
  return options.profile === 'local-bearer-v1'
    ? localVerifier(options)
    : remoteVerifier(options);
}

export async function digestLocalBearerToken(
  tokenBytes: Uint8Array,
): Promise<string> {
  if (tokenBytes.byteLength !== 32) throw invalidCredential();
  const material = new Uint8Array(LOCAL_PREFIX.length + tokenBytes.length);
  material.set(LOCAL_PREFIX);
  material.set(tokenBytes, LOCAL_PREFIX.length);
  try {
    return hex(await crypto.subtle.digest('SHA-256', material));
  } finally {
    material.fill(0);
  }
}

export function decodeLocalBearerCredentialFile(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== 43 && bytes.byteLength !== 44)
    throw invalidCredential();
  if (bytes.byteLength === 44 && bytes[43] !== 0x0a) throw invalidCredential();
  const encoded = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(0, 43),
  );
  if (!BASE64URL_32.test(encoded)) throw invalidCredential();
  const decoded = base64urlDecode(encoded);
  if (decoded.byteLength !== 32 || base64urlEncode(decoded) !== encoded) {
    decoded.fill(0);
    throw invalidCredential();
  }
  return decoded;
}

function localVerifier(
  options: LocalBearerAuthOptions,
): AuthenticationVerifier {
  return {
    profile: 'local-bearer-v1',
    challenge: 'Bearer',
    protectedResourceMetadata: () => null,
    async authenticate(request) {
      rejectAlternateTokenSources(request);
      const token = bearerToken(request);
      if (!BASE64URL_32.test(token)) throw unauthenticated();
      const decoded = base64urlDecode(token);
      if (decoded.byteLength !== 32) throw unauthenticated();
      let digest: string;
      try {
        digest = await digestLocalBearerToken(decoded);
      } finally {
        decoded.fill(0);
      }
      const record = await options.credentials.findByDigest(
        digest,
        request.signal,
      );
      if (!record || record.disabled) throw unauthenticated();
      if (!constantTimeHex(record.tokenDigest, digest)) throw unauthenticated();
      return options.authorization.recheck(
        {
          installationId: record.installationId,
          principalId: record.principalId,
          activeWorkspaceId: record.activeWorkspaceId,
          capabilities: [...record.capabilities],
          authorizationRevision: record.authorizationRevision,
          credentialId: record.credentialId,
        },
        request.signal,
      );
    },
  };
}

function remoteVerifier(
  options: RemoteOAuthAuthOptions,
): AuthenticationVerifier {
  validateRemoteConfig(options.config);
  const metadataUrl =
    `${new URL(options.config.resource).origin}/` +
    '.well-known/oauth-protected-resource/mcp';
  return {
    profile: 'remote-oauth-v1',
    challenge: `Bearer resource_metadata="${metadataUrl}"`,
    protectedResourceMetadata: () => ({
      resource: options.config.resource,
      authorization_servers: [...options.config.authorizationServers],
      bearer_methods_supported: ['header'],
      scopes_supported: [...options.config.requiredScopes],
    }),
    async authenticate(request) {
      rejectAlternateTokenSources(request);
      const token = bearerToken(request);
      if (token.length > MAX_OAUTH_TOKEN) throw unauthenticated();
      const verified = await options.jwt.verify(
        token,
        options.config,
        request.signal,
      );
      const now = (options.clock ?? (() => new Date()))().getTime() / 1000;
      const skew = options.config.maxClockSkewSeconds;
      const algorithm = requiredClaim(verified.header, 'alg');
      if (!options.config.algorithms.includes(algorithm))
        throw unauthenticated();
      if (requiredClaim(verified.claims, 'iss') !== options.config.issuer)
        throw unauthenticated();
      const audience = verified.claims.aud;
      const audiences = Array.isArray(audience)
        ? audience.filter((value): value is string => typeof value === 'string')
        : typeof audience === 'string'
          ? [audience]
          : [];
      if (!audiences.includes(options.config.audience)) throw unauthenticated();
      const expires = numericClaim(verified.claims, 'exp');
      const notBefore =
        verified.claims.nbf === undefined
          ? 0
          : numericClaim(verified.claims, 'nbf');
      if (expires < now - skew || notBefore > now + skew)
        throw unauthenticated();
      const scopes = scopeSet(verified.claims.scope);
      if (
        options.config.requiredScopes.some(
          (required) => !scopes.includes(required),
        )
      )
        throw new WorkshopError('forbidden', 'Authorization denied', 403);
      const capabilities = [
        ...new Set(
          scopes
            .map((scope) => options.config.scopeCapabilityMap[scope])
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort();
      const resolved = await options.principals.resolve(
        {
          installationId: requiredClaim(
            verified.claims,
            options.config.installationClaim,
          ),
          principalId: requiredClaim(
            verified.claims,
            options.config.principalClaim,
          ),
          activeWorkspaceId: optionalClaim(
            verified.claims,
            options.config.workspaceClaim,
          ),
          credentialId: requiredClaim(
            verified.claims,
            options.config.credentialClaim,
          ),
          scopes,
          capabilities,
        },
        request.signal,
      );
      return options.authorization.recheck(resolved, request.signal);
    },
  };
}

function validateRemoteConfig(config: RemoteOAuthConfig): void {
  if (
    new URL(config.issuer).protocol !== 'https:' ||
    new URL(config.resource).protocol !== 'https:' ||
    config.authorizationServers.length === 0 ||
    config.authorizationServers.some(
      (server) => new URL(server).protocol !== 'https:',
    ) ||
    config.algorithms.length === 0 ||
    config.algorithms.some((algorithm) => algorithm === 'none') ||
    config.requiredScopes.length === 0 ||
    !Number.isSafeInteger(config.maxClockSkewSeconds) ||
    config.maxClockSkewSeconds < 0 ||
    config.maxClockSkewSeconds > 300
  )
    throw new WorkshopError(
      'validation_failed',
      'Remote OAuth configuration is invalid',
      400,
    );
}

function rejectAlternateTokenSources(request: Request): void {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (/token|authorization|credential/iu.test(key)) throw unauthenticated();
  }
  if (
    request.headers.has('cookie') ||
    request.headers.has('x-api-key') ||
    request.headers.has('proxy-authorization')
  )
    throw unauthenticated();
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization');
  if (
    !header ||
    header.length > MAX_AUTHORIZATION_HEADER ||
    !header.startsWith('Bearer ') ||
    header.slice(7).length === 0 ||
    /[\u0000-\u0020\u007f]/u.test(header.slice(7))
  )
    throw unauthenticated();
  return header.slice(7);
}

function requiredClaim(
  claims: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = claims[name];
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw unauthenticated();
  return value;
}

function optionalClaim(
  claims: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const value = claims[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw unauthenticated();
  return value;
}

function numericClaim(
  claims: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = claims[name];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw unauthenticated();
  return value;
}

function scopeSet(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 16_384)
    throw unauthenticated();
  return [...new Set(value.split(' ').filter(Boolean))].sort();
}

function base64urlDecode(value: string): Uint8Array {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw unauthenticated();
  }
}

function base64urlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function constantTimeHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right))
    return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function unauthenticated(): WorkshopError {
  return new WorkshopError('unauthenticated', 'Authentication required', 401);
}

function invalidCredential(): WorkshopError {
  return new WorkshopError(
    'validation_failed',
    'Local credential file is invalid',
    400,
  );
}
