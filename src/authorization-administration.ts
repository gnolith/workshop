import {
  commitAuthorizationAdministrationV1,
  prepareAuthorizationAdministrationV1,
  registerAuthorizationAdministrationOwnerV1,
  type AuthorizationAdministrationCommandV1,
  type AuthorizationAdministrationOwnerAdapterV1,
  type AuthorizationAdministrationOwnerIssuerV1,
  type TaprootHostWriteCapability,
  type TaprootOptions,
} from '@gnolith/taproot';
import type { OperationCallContext } from './operations.js';
import type { AuthenticatedPrincipal } from './protocol.js';
import { WorkshopError } from './protocol/errors.js';
import type { D1DatabaseLike } from './server/database.js';
import { digestWorkshopOperationRequest } from './server/idempotency.js';

type Input = Readonly<Record<string, unknown>>;

interface PendingAdministration {
  input: Input;
  context: OperationCallContext;
  requestDigest: string;
  command: AuthorizationAdministrationCommandV1;
  target: { kind: string; id: string };
  auditId: string;
  createdAt: string;
}

export interface WorkshopAuthorizationAdministrationV1 {
  call(input: Input, context: OperationCallContext): Promise<unknown>;
  assertPrincipalActive(principal: AuthenticatedPrincipal): Promise<void>;
}

export interface WorkshopAuthorizationAdministrationOptionsV1 {
  db: D1DatabaseLike;
  taprootOptions: TaprootOptions;
  hostAuthority: TaprootHostWriteCapability;
  installationId: string;
  ownerRegistrationId?: string;
  clock?: () => Date;
  createId?: () => string;
}

export async function createWorkshopAuthorizationAdministrationV1(
  options: WorkshopAuthorizationAdministrationOptionsV1,
): Promise<WorkshopAuthorizationAdministrationV1> {
  const owner = createOwner(options.db);
  const issuer = await registerAuthorizationAdministrationOwnerV1(
    options.db,
    options.taprootOptions,
    options.hostAuthority,
    {
      installationId: options.installationId,
      ownerRegistrationId:
        options.ownerRegistrationId ?? 'workshop-authorization-admin-v1',
      adapter: owner.adapter,
    },
  );
  return new WorkshopAuthorizationAdministration(options, owner, issuer);
}

class WorkshopAuthorizationAdministration implements WorkshopAuthorizationAdministrationV1 {
  constructor(
    private readonly options: WorkshopAuthorizationAdministrationOptionsV1,
    private readonly owner: OwnerController,
    private readonly issuer: AuthorizationAdministrationOwnerIssuerV1,
  ) {}

  async assertPrincipalActive(
    principal: AuthenticatedPrincipal,
  ): Promise<void> {
    const row = await this.options.db
      .prepare(
        `SELECT lifecycle FROM workshop_authorization_principals
         WHERE installation_id = ? AND principal_id = ?`,
      )
      .bind(principal.installationId, principal.principalId)
      .first<{ lifecycle: string }>();
    if (row && row.lifecycle !== 'active') throw forbidden();
  }

  async call(input: Input, context: OperationCallContext): Promise<unknown> {
    assertInstallation(this.options.installationId, context.principal);
    const action = string(input.action);
    if (action === 'status') return this.status(context);
    if (action === 'effective-policy') return this.effective(input, context);

    const expectedAuthorizationRevision = integer(input.expectedPolicyRevision);
    const idempotencyKey = string(input.idempotencyKey);
    const requestDigest = await digestWorkshopOperationRequest({
      operation: 'authorization_admin',
      input,
    });
    const existing = await receipt(
      this.options.db,
      context.principal,
      idempotencyKey,
    );
    if (existing) {
      if (existing.request_digest !== requestDigest) throw conflict();
      return { ...parseReceipt(existing.response_json), status: 'replayed' };
    }
    const command = await commandFor(this.options.db, input, context);
    const target = targetFor(input, context);
    const createdAt = (
      this.options.clock ?? (() => new Date())
    )().toISOString();
    const auditId = `authorization-audit:${
      this.options.createId?.() ?? crypto.randomUUID()
    }`;
    const pending: PendingAdministration = {
      input,
      context,
      requestDigest,
      command,
      target,
      auditId,
      createdAt,
    };
    try {
      const participant = await prepareAuthorizationAdministrationV1(
        this.options.db,
        this.options.taprootOptions,
        this.options.hostAuthority,
        {
          installationId: this.options.installationId,
          expectedAuthorizationRevision,
          idempotencyKey,
          command,
        },
        authorization(context.principal),
      );
      const ownerParticipant = await this.issuer.seal(
        participant,
        this.owner.issue(pending),
      );
      const committed = await commitAuthorizationAdministrationV1(
        participant,
        ownerParticipant,
      );
      const stored = await receipt(
        this.options.db,
        context.principal,
        idempotencyKey,
      );
      if (!stored || stored.request_digest !== requestDigest)
        throw new WorkshopError(
          'internal_error',
          'Authorization owner receipt is unavailable',
          500,
        );
      const output = parseReceipt(stored.response_json);
      return {
        ...output,
        status: committed.replayed ? 'replayed' : 'committed',
        policyRevision: committed.authorizationRevision,
      };
    } catch (error) {
      mapTaprootAdministrationError(error);
    }
  }

  private async status(context: OperationCallContext): Promise<unknown> {
    const [principals, credentials, bindings, audits] = await Promise.all([
      count(
        this.options.db,
        'workshop_authorization_principals',
        this.options.installationId,
      ),
      count(
        this.options.db,
        'workshop_credentials',
        this.options.installationId,
      ),
      count(
        this.options.db,
        'workshop_oauth_bindings',
        this.options.installationId,
      ),
      count(
        this.options.db,
        'workshop_authorization_audit',
        this.options.installationId,
      ),
    ]);
    return {
      version: 1,
      action: 'status',
      policyRevision: context.principal.authorizationRevision,
      value: { principals, credentials, oauthBindings: bindings, audits },
    };
  }

  private async effective(
    input: Input,
    context: OperationCallContext,
  ): Promise<unknown> {
    const target = object(input.target);
    const kind = string(target.kind);
    const id = string(target.id);
    const policy =
      kind === 'entity'
        ? await this.options.db
            .prepare(
              `SELECT source_revision, authorization_revision AS policy_revision,
                      workspace_id, owner_principal_id, visibility_json
                 FROM taproot_entity_authorization
                WHERE installation_id = ? AND entity_id = ?`,
            )
            .bind(this.options.installationId, id)
            .first<{
              source_revision: number;
              policy_revision: number;
              workspace_id: string | null;
              owner_principal_id: string;
              visibility_json: string;
            }>()
        : kind === 'resource' || kind === 'annotation'
          ? await this.options.db
              .prepare(
                `SELECT revision AS source_revision,
                        policy_revision, NULL AS workspace_id,
                        NULL AS owner_principal_id, visibility_json
                   FROM ${
                     kind === 'resource'
                       ? 'taproot_resources'
                       : 'taproot_annotations'
                   }
                  WHERE installation_id = ? AND record_id = ?`,
              )
              .bind(this.options.installationId, id)
              .first<{
                source_revision: number;
                policy_revision: number;
                workspace_id: null;
                owner_principal_id: null;
                visibility_json: string;
              }>()
          : null;
    if (!policy)
      throw new WorkshopError(
        'not_found',
        'Authorization policy target was not found',
        404,
      );
    return {
      version: 1,
      action: 'effective-policy',
      policyRevision: context.principal.authorizationRevision,
      value: {
        target: { kind, id },
        sourceRevision: Number(policy.source_revision),
        sourcePolicyRevision: Number(policy.policy_revision),
        workspaceId: policy.workspace_id,
        ownerPrincipalId: policy.owner_principal_id,
        visibility: parsePolicyJson(policy.visibility_json),
        principalId: context.principal.principalId,
        activeWorkspaceId: context.principal.activeWorkspaceId,
        workspaceIds: [...(context.principal.workspaceIds ?? [])],
        capabilities: [...context.principal.capabilities],
      },
    };
  }
}

interface OwnerController {
  adapter: AuthorizationAdministrationOwnerAdapterV1;
  issue(payload: PendingAdministration): object;
}

function createOwner(db: D1DatabaseLike): OwnerController {
  const pending = new WeakMap<object, PendingAdministration>();
  return {
    adapter: {
      kind: 'taproot-authorization-administration-owner-adapter-v1',
      prepare(ownerToken) {
        if (!ownerToken || typeof ownerToken !== 'object')
          throw new WorkshopError(
            'forbidden',
            'Authorization administration owner token is invalid',
            403,
          );
        const payload = pending.get(ownerToken);
        if (!payload)
          throw new WorkshopError(
            'forbidden',
            'Authorization administration owner token is invalid',
            403,
          );
        pending.delete(ownerToken);
        const action = string(payload.input.action);
        const policyRevision =
          integer(payload.input.expectedPolicyRevision) + 1;
        const response = {
          version: 1,
          action,
          status: 'committed',
          policyRevision,
          auditId: payload.auditId,
          target: payload.target,
        };
        return Promise.resolve({
          statements: [
            ...ownerMutationStatements(db, payload),
            db
              .prepare(
                `INSERT INTO workshop_authorization_audit (
                   audit_id, installation_id, actor_principal_id, action,
                   target_kind, target_id, authorization_revision,
                   details_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                payload.auditId,
                payload.context.principal.installationId,
                payload.context.principal.principalId,
                action,
                payload.target.kind,
                payload.target.id,
                policyRevision,
                JSON.stringify({ version: 1, action, target: payload.target }),
                payload.createdAt,
              ),
            db
              .prepare(
                `INSERT INTO workshop_authorization_admin_receipts (
                   installation_id, actor_principal_id, idempotency_key,
                   action, request_digest, response_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                payload.context.principal.installationId,
                payload.context.principal.principalId,
                string(payload.input.idempotencyKey),
                action,
                payload.requestDigest,
                JSON.stringify(response),
                payload.createdAt,
              ),
          ],
          receipt: {
            format: 'workshop-authorization-administration-owner-receipt-v1',
            action,
            auditId: payload.auditId,
            target: payload.target,
            requestDigest: payload.requestDigest,
          },
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

function parsePolicyJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new WorkshopError(
      'internal_error',
      'Authorization policy record is invalid',
      500,
    );
  }
}

function ownerMutationStatements(
  db: D1DatabaseLike,
  payload: PendingAdministration,
) {
  const action = string(payload.input.action);
  const installationId = payload.context.principal.installationId;
  const now = payload.createdAt;
  switch (action) {
    case 'principal-create': {
      const principal = object(payload.input.principal);
      return [
        db
          .prepare(
            `INSERT INTO workshop_authorization_principals (
               installation_id, principal_id, lifecycle, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(installation_id, principal_id) DO UPDATE SET
               lifecycle = excluded.lifecycle, updated_at = excluded.updated_at`,
          )
          .bind(
            installationId,
            string(principal.principalId),
            principal.enabled === false ? 'disabled' : 'active',
            now,
            now,
          ),
      ];
    }
    case 'principal-enable':
    case 'principal-disable':
    case 'principal-revoke':
      return [
        db
          .prepare(
            `INSERT INTO workshop_authorization_principals (
               installation_id, principal_id, lifecycle, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(installation_id, principal_id) DO UPDATE SET
               lifecycle = excluded.lifecycle, updated_at = excluded.updated_at`,
          )
          .bind(
            installationId,
            string(payload.input.principalId),
            action === 'principal-enable'
              ? 'active'
              : action === 'principal-disable'
                ? 'disabled'
                : 'revoked',
            now,
            now,
          ),
        ...(action === 'principal-enable'
          ? []
          : [
              db
                .prepare(
                  `UPDATE workshop_credentials SET disabled = 1
                   WHERE installation_id = ? AND principal_id = ?`,
                )
                .bind(installationId, string(payload.input.principalId)),
              db
                .prepare(
                  `UPDATE workshop_oauth_bindings
                   SET active = 0, updated_at = ?
                   WHERE installation_id = ? AND principal_id = ?`,
                )
                .bind(now, installationId, string(payload.input.principalId)),
            ]),
      ];
    case 'workspace-membership-add':
    case 'workspace-membership-remove':
      return [
        db
          .prepare(
            `INSERT INTO workshop_workspace_memberships (
               installation_id, principal_id, workspace_id, active, updated_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(installation_id, principal_id, workspace_id)
             DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at`,
          )
          .bind(
            installationId,
            string(payload.input.principalId),
            string(payload.input.workspaceId),
            action === 'workspace-membership-add' ? 1 : 0,
            now,
          ),
      ];
    case 'credential-register': {
      const credential = object(payload.input.credential);
      return [
        db
          .prepare(
            `INSERT INTO workshop_credentials (
               installation_id, credential_id, profile, token_digest,
               principal_id, workspace_id, disabled, created_at
             ) VALUES (?, ?, 'local-bearer-v1', ?, ?, ?, 0, ?)
             ON CONFLICT(installation_id, credential_id) DO UPDATE SET
               token_digest = excluded.token_digest,
               principal_id = excluded.principal_id,
               workspace_id = excluded.workspace_id,
               disabled = 0`,
          )
          .bind(
            installationId,
            string(credential.credentialId),
            digest(credential.tokenDigest),
            string(credential.principalId),
            string(credential.workspaceId),
            now,
          ),
      ];
    }
    case 'credential-revoke':
      return [
        db
          .prepare(
            `UPDATE workshop_credentials SET disabled = 1
             WHERE installation_id = ? AND credential_id = ?`,
          )
          .bind(installationId, string(payload.input.credentialId)),
      ];
    case 'oauth-bind': {
      const binding = object(payload.input.binding);
      return [
        db
          .prepare(
            `INSERT INTO workshop_oauth_bindings (
               installation_id, issuer, subject, principal_id, workspace_id,
               credential_id, active, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(installation_id, issuer, subject) DO UPDATE SET
               principal_id = excluded.principal_id,
               workspace_id = excluded.workspace_id,
               credential_id = excluded.credential_id,
               active = 1, updated_at = excluded.updated_at`,
          )
          .bind(
            installationId,
            url(binding.issuer),
            string(binding.subject),
            string(binding.principalId),
            string(binding.workspaceId),
            string(binding.credentialId),
            now,
            now,
          ),
      ];
    }
    case 'oauth-unbind':
      return [
        db
          .prepare(
            `UPDATE workshop_oauth_bindings SET active = 0, updated_at = ?
             WHERE installation_id = ? AND issuer = ? AND subject = ?`,
          )
          .bind(
            now,
            installationId,
            url(payload.input.issuer),
            string(payload.input.subject),
          ),
      ];
    default:
      return [];
  }
}

async function commandFor(
  db: D1DatabaseLike,
  input: Input,
  context: OperationCallContext,
): Promise<AuthorizationAdministrationCommandV1> {
  const action = string(input.action);
  if (action === 'principal-create') {
    const principal = object(input.principal);
    return {
      type: 'put-principal',
      principalId: string(principal.principalId),
    };
  }
  if (
    action === 'principal-enable' ||
    action === 'principal-disable' ||
    action === 'principal-revoke'
  )
    return { type: 'put-principal', principalId: string(input.principalId) };
  if (
    action === 'workspace-membership-add' ||
    action === 'workspace-membership-remove'
  )
    return { type: 'put-workspace', workspaceId: string(input.workspaceId) };
  if (action === 'workspace-grant-add' || action === 'workspace-grant-remove')
    return {
      type: 'put-grant',
      principalId: string(input.principalId),
      workspaceId: string(input.workspaceId),
      capability: string(input.capability),
      granted: action === 'workspace-grant-add',
    };
  if (action === 'credential-register') {
    const credential = object(input.credential);
    return {
      type: 'put-principal',
      principalId: string(credential.principalId),
    };
  }
  if (action === 'oauth-bind') {
    const binding = object(input.binding);
    return { type: 'put-principal', principalId: string(binding.principalId) };
  }
  if (action === 'visibility-policy-set') {
    const target = object(input.target);
    const visibility = input.visibility as never;
    const expectedRevision = integer(input.expectedTargetRevision);
    switch (string(target.kind)) {
      case 'entity':
        return {
          type: 'set-entity-visibility',
          entityId: string(target.id),
          expectedRevision,
          visibility,
        };
      case 'resource':
        return {
          type: 'set-resource-visibility',
          resourceId: string(target.id),
          expectedRevision,
          visibility,
        };
      case 'annotation':
        return {
          type: 'set-annotation-visibility',
          annotationId: string(target.id),
          expectedRevision,
          visibility,
        };
    }
  }
  if (action === 'credential-revoke') {
    const row = await db
      .prepare(
        `SELECT principal_id FROM workshop_credentials
         WHERE installation_id = ? AND credential_id = ?`,
      )
      .bind(context.principal.installationId, string(input.credentialId))
      .first<{ principal_id: string }>();
    return {
      type: 'put-principal',
      principalId: row?.principal_id ?? context.principal.principalId,
    };
  }
  if (action === 'oauth-unbind') {
    const row = await db
      .prepare(
        `SELECT principal_id FROM workshop_oauth_bindings
         WHERE installation_id = ? AND issuer = ? AND subject = ?`,
      )
      .bind(
        context.principal.installationId,
        url(input.issuer),
        string(input.subject),
      )
      .first<{ principal_id: string }>();
    return {
      type: 'put-principal',
      principalId: row?.principal_id ?? context.principal.principalId,
    };
  }
  throw new WorkshopError(
    'validation_failed',
    'Authorization administration action is invalid',
    400,
  );
}

function targetFor(
  input: Input,
  context: OperationCallContext,
): { kind: string; id: string } {
  const action = string(input.action);
  if (action === 'principal-create') {
    const value = object(input.principal);
    return { kind: 'principal', id: string(value.principalId) };
  }
  if (action.startsWith('principal-'))
    return { kind: 'principal', id: string(input.principalId) };
  if (action.startsWith('workspace-membership'))
    return {
      kind: 'membership',
      id: `${string(input.principalId)}@${string(input.workspaceId)}`,
    };
  if (action.startsWith('workspace-grant'))
    return {
      kind: 'grant',
      id: `${string(input.principalId)}@${string(input.workspaceId)}:${string(input.capability)}`,
    };
  if (action === 'credential-register') {
    const value = object(input.credential);
    return { kind: 'credential', id: string(value.credentialId) };
  }
  if (action === 'credential-revoke')
    return { kind: 'credential', id: string(input.credentialId) };
  if (action === 'oauth-bind') {
    const value = object(input.binding);
    return {
      kind: 'oauth',
      id: `${url(value.issuer)}#${string(value.subject)}`,
    };
  }
  if (action === 'oauth-unbind')
    return {
      kind: 'oauth',
      id: `${url(input.issuer)}#${string(input.subject)}`,
    };
  if (action === 'visibility-policy-set') {
    const value = object(input.target);
    return { kind: string(value.kind), id: string(value.id) };
  }
  return { kind: 'principal', id: context.principal.principalId };
}

function authorization(principal: AuthenticatedPrincipal) {
  if (!principal.workspaceIds)
    throw new WorkshopError(
      'dependency_unavailable',
      'Live Taproot authorization context is unavailable',
      503,
    );
  return {
    installationId: principal.installationId,
    principalId: principal.principalId,
    activeWorkspaceId: principal.activeWorkspaceId,
    workspaceIds: principal.workspaceIds,
    capabilities: principal.capabilities,
    authorizationRevision: principal.authorizationRevision,
  };
}

async function receipt(
  db: D1DatabaseLike,
  principal: AuthenticatedPrincipal,
  key: string,
) {
  return db
    .prepare(
      `SELECT request_digest, response_json
       FROM workshop_authorization_admin_receipts
       WHERE installation_id = ? AND actor_principal_id = ?
         AND idempotency_key = ?`,
    )
    .bind(principal.installationId, principal.principalId, key)
    .first<{ request_digest: string; response_json: string }>();
}

async function count(
  db: D1DatabaseLike,
  table: string,
  installationId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE installation_id = ?`)
    .bind(installationId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function parseReceipt(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return object(parsed);
  } catch {
    throw new WorkshopError(
      'internal_error',
      'Authorization administration receipt is invalid',
      500,
    );
  }
}

function mapTaprootAdministrationError(error: unknown): never {
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
  if (error instanceof WorkshopError) throw error;
  throw new WorkshopError(
    'internal_error',
    'Authorization administration failed',
    500,
    {
      taprootErrorName:
        typeof candidate?.name === 'string'
          ? candidate.name.slice(0, 128)
          : 'unknown',
      taprootErrorCode:
        typeof candidate?.code === 'string'
          ? candidate.code.slice(0, 128)
          : 'unknown',
    },
  );
}

function assertInstallation(
  installationId: string,
  principal: AuthenticatedPrincipal,
): void {
  if (principal.installationId !== installationId) throw forbidden();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkshopError('validation_failed', 'Expected an object', 400);
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new WorkshopError('validation_failed', 'Expected bounded text', 400);
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new WorkshopError(
      'validation_failed',
      'Expected a positive revision',
      400,
    );
  return Number(value);
}

function digest(value: unknown): string {
  const result = string(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new WorkshopError(
      'validation_failed',
      'Credential digest is invalid',
      400,
    );
  return result;
}

function url(value: unknown): string {
  const result = string(value);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new WorkshopError('validation_failed', 'URL is invalid', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new WorkshopError('validation_failed', 'URL is invalid', 400);
  return parsed.href;
}

function forbidden(): WorkshopError {
  return new WorkshopError('forbidden', 'Authorization denied', 403);
}

function conflict(): WorkshopError {
  return new WorkshopError(
    'conflict',
    'Authorization revision or idempotency key conflicts',
    409,
  );
}
