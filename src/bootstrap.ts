import type {
  AuthorizationBootstrapOwnerAdapterV1,
  AuthorizationBootstrapOwnerIssuerV1,
  AuthorizationBootstrapOwnerParticipantV1,
  AuthorizationBootstrapParticipantV1,
  AuthorizationBootstrapReceiptV1,
} from '@gnolith/taproot';
import {
  decodeLocalBearerCredentialFile,
  digestLocalBearerToken,
} from './server/auth.js';
import type { D1DatabaseLike } from './server/database.js';
import { WorkshopError } from './protocol/errors.js';

export const WORKSHOP_BOOTSTRAP_VERSION = 1 as const;
export const WORKSHOP_OWNER_GRANTS_V1 = [
  'admin',
  'knowledge:policy',
  'knowledge:write',
  'memory:write',
  'prompt:write',
  'read',
  'search:admin',
  'task:write',
] as const;

export interface ProtectedCredentialSelector {
  kind: 'file' | 'inherited-descriptor';
  value: string | number;
}

export interface BootstrapWorkshopV1Input {
  version: 1;
  installationId: string;
  baseIri: string;
  principalId: string;
  workspaceId: string;
  credential: ProtectedCredentialSelector;
  idempotencyKey: string;
  profile: 'local-bearer-v1';
}

interface WorkshopBootstrapOwnerPayloadV1 {
  installationId: string;
  credentialId: string;
  credentialDigest: string;
  principalId: string;
  workspaceId: string;
  idempotencyKey: string;
  grantManifestDigest: string;
  createdAt: string;
}

export interface WorkshopBootstrapOwnerControllerV1 {
  readonly adapter: AuthorizationBootstrapOwnerAdapterV1;
  issue(payload: WorkshopBootstrapOwnerPayloadV1): object;
}

export function createWorkshopBootstrapOwnerAdapterV1(
  db: D1DatabaseLike,
): WorkshopBootstrapOwnerControllerV1 {
  const pending = new WeakMap<object, WorkshopBootstrapOwnerPayloadV1>();
  return {
    adapter: {
      kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
      prepare(ownerToken) {
        if (!isObjectToken(ownerToken)) throw invalidOwnerToken();
        const payload = pending.get(ownerToken);
        if (!payload) throw invalidOwnerToken();
        pending.delete(ownerToken);
        const ownerReceipt = {
          format: 'workshop-authorization-bootstrap-owner-receipt-v1',
          installationId: payload.installationId,
          credentialId: payload.credentialId,
          credentialDigest: payload.credentialDigest,
          principalId: payload.principalId,
          workspaceId: payload.workspaceId,
          idempotencyKey: payload.idempotencyKey,
          grantManifestDigest: payload.grantManifestDigest,
          workshopSchemaVersion: 9,
        } as const;
        const receiptJson = canonicalize(ownerReceipt);
        return Promise.resolve({
          statements: [
            db
              .prepare(
                `INSERT INTO workshop_credentials (
                   installation_id, credential_id, profile, token_digest,
                   principal_id, workspace_id, disabled, created_at
                 ) VALUES (?, ?, 'local-bearer-v1', ?, ?, ?, 0, ?)
                 ON CONFLICT(installation_id, credential_id) DO NOTHING`,
              )
              .bind(
                payload.installationId,
                payload.credentialId,
                payload.credentialDigest,
                payload.principalId,
                payload.workspaceId,
                payload.createdAt,
              ),
            db
              .prepare(
                `INSERT INTO workshop_bootstrap_receipts (
                   installation_id, idempotency_key, credential_id,
                   principal_id, workspace_id, grant_manifest_digest,
                   owner_receipt_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(installation_id, idempotency_key) DO NOTHING`,
              )
              .bind(
                payload.installationId,
                payload.idempotencyKey,
                payload.credentialId,
                payload.principalId,
                payload.workspaceId,
                payload.grantManifestDigest,
                receiptJson,
                payload.createdAt,
              ),
          ],
          receipt: ownerReceipt,
        });
      },
    },
    issue(payload) {
      const token = {};
      pending.set(token, payload);
      return token;
    },
  };
}

export interface BootstrapWorkshopV1Dependencies {
  prepareAuthorizationBootstrapV1(input: {
    installationId: string;
    baseIri: string;
    principalId: string;
    workspaceId: string;
    grants: readonly string[];
    idempotencyKey: string;
  }): Promise<AuthorizationBootstrapParticipantV1>;
  ownerParticipantIssuer: AuthorizationBootstrapOwnerIssuerV1;
  ownerAdapter: WorkshopBootstrapOwnerControllerV1;
  commitAuthorizationBootstrapV1(
    participant: AuthorizationBootstrapParticipantV1,
    ownerParticipant: AuthorizationBootstrapOwnerParticipantV1,
  ): Promise<AuthorizationBootstrapReceiptV1>;
  readProtectedCredential(
    selector: ProtectedCredentialSelector,
  ): Promise<Uint8Array>;
  workshopSchemaVersion: number;
  clock?: () => Date;
}

export interface BootstrapWorkshopV1Receipt {
  version: 1;
  bootstrapId: string;
  installationId: string;
  principalId: string;
  workspaceId: string;
  authorizationRevision: number;
  grantManifestDigest: string;
  replayed: boolean;
  workshopSchemaVersion: number;
  credentialId: string;
  credentialDigest: string;
}

export async function bootstrapWorkshopV1(
  input: BootstrapWorkshopV1Input,
  dependencies: BootstrapWorkshopV1Dependencies,
): Promise<BootstrapWorkshopV1Receipt> {
  validateInput(input);
  if (dependencies.workshopSchemaVersion !== 9)
    throw new WorkshopError(
      'dependency_unavailable',
      'Workshop schema migration 0009 is required before bootstrap',
      503,
    );
  const credentialFile = await dependencies.readProtectedCredential(
    input.credential,
  );
  let tokenBytes: Uint8Array | undefined;
  try {
    tokenBytes = decodeLocalBearerCredentialFile(credentialFile);
    const credentialDigest = await digestLocalBearerToken(tokenBytes);
    const grantManifestDigest = await sha256Hex(
      JSON.stringify(WORKSHOP_OWNER_GRANTS_V1),
    );
    const credentialId = `credential:${(
      await sha256Hex(
        canonicalize({
          installationId: input.installationId,
          idempotencyKey: input.idempotencyKey,
          credentialDigest,
        }),
      )
    ).slice(0, 32)}`;
    const participant = await dependencies.prepareAuthorizationBootstrapV1({
      installationId: input.installationId,
      baseIri: input.baseIri,
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      grants: WORKSHOP_OWNER_GRANTS_V1,
      idempotencyKey: input.idempotencyKey,
    });
    const ownerToken = dependencies.ownerAdapter.issue({
      installationId: input.installationId,
      credentialId,
      credentialDigest,
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      grantManifestDigest,
      createdAt: (dependencies.clock?.() ?? new Date()).toISOString(),
    });
    const ownerParticipant = await dependencies.ownerParticipantIssuer.seal(
      participant,
      ownerToken,
    );
    const committed = await dependencies.commitAuthorizationBootstrapV1(
      participant,
      ownerParticipant,
    );
    if (
      committed.installationId !== input.installationId ||
      committed.principalId !== input.principalId ||
      committed.workspaceId !== input.workspaceId ||
      committed.grantManifestSha256 !== grantManifestDigest
    )
      throw new WorkshopError(
        'dependency_unavailable',
        'Taproot bootstrap receipt does not match the Workshop request',
        503,
      );
    return {
      version: 1,
      bootstrapId: committed.bootstrapId,
      installationId: committed.installationId,
      principalId: committed.principalId,
      workspaceId: committed.workspaceId,
      authorizationRevision: committed.authorizationRevision,
      grantManifestDigest,
      replayed: committed.replayed,
      workshopSchemaVersion: dependencies.workshopSchemaVersion,
      credentialId,
      credentialDigest,
    };
  } finally {
    credentialFile.fill(0);
    tokenBytes?.fill(0);
  }
}

function validateInput(input: BootstrapWorkshopV1Input): void {
  if (
    input.version !== 1 ||
    input.profile !== 'local-bearer-v1' ||
    !validId(input.installationId) ||
    !validId(input.principalId) ||
    !validId(input.workspaceId) ||
    !validId(input.idempotencyKey) ||
    !input.credential ||
    !['file', 'inherited-descriptor'].includes(input.credential.kind)
  )
    throw new WorkshopError(
      'validation_failed',
      'Bootstrap input is invalid',
      400,
    );
  const baseIri = new URL(input.baseIri);
  if (!['https:', 'http:'].includes(baseIri.protocol))
    throw new WorkshopError(
      'validation_failed',
      'Bootstrap base IRI is invalid',
      400,
    );
}

function validId(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isObjectToken(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function invalidOwnerToken(): WorkshopError {
  return new WorkshopError(
    'validation_failed',
    'Workshop bootstrap owner token is invalid or already consumed',
    400,
  );
}
