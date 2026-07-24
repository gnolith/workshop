import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  bootstrapTaprootAuthorization,
  commitAuthorizationBootstrapV1,
  createAuthorizationCursorCodec,
  createTaprootHostWriteCapability,
  initializeTaproot,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
} from '@gnolith/taproot';
import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkshopMigrations } from '../src/migrations.js';
import {
  createOperationRuntime,
  type OperationCallContext,
} from '../src/operations.js';
import type { AuthorizationContext } from '../src/protocol.js';
import { createWorkshopCore } from '../src/server/context.js';
import { digestLocalBearerCredentialText } from '../src/server/auth.js';
import { createWorkshopSearchIntegrationV1 } from '../src/server/search.js';
import { createWorkshopTaprootOperationPortV1 } from '../src/taproot-operation.js';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from '../src/server/database.js';
import type { WorkshopAuthorizationAuthority } from '../src/server/authorization.js';
import {
  createTestCursorCodec,
  createTestKnowledgeOptions,
} from './helpers.js';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe('Workshop external search producers', () => {
  it('coordinates authorization administration with durable Workshop owner state', async () => {
    const path = join(tmpdir(), `workshop-admin-${randomUUID()}.sqlite`);
    paths.push(path);
    const db = new NodeSqliteDatabase(path);
    const workshopDb = db as unknown as D1DatabaseLike;
    const taproot = { baseIri: 'https://workshop-admin.test/' };
    const installationId = 'installation:admin-test';
    try {
      await initializeTaproot(db, taproot);
      await applyWorkshopMigrations(workshopDb);
      const hostKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hostAuthority = createTaprootHostWriteCapability(
        db,
        taproot,
        hostKey,
      );
      const bootstrapOwner = await registerAuthorizationBootstrapOwnerV1(
        db,
        taproot,
        hostAuthority,
        {
          installationId,
          ownerRegistrationId: 'workshop-admin-test-bootstrap',
          adapter: {
            kind: 'taproot-authorization-bootstrap-owner-adapter-v1',
            async prepare() {
              return {
                statements: [],
                receipt: { format: 'workshop-admin-test-owner-v1' },
              };
            },
          },
        },
      );
      const bootstrapParticipant = await prepareAuthorizationBootstrapV1(
        db,
        taproot,
        hostAuthority,
        {
          installationId,
          baseIri: taproot.baseIri,
          principalId: 'principal:owner',
          workspaceId: 'workspace:admin-test',
          grants: [
            'admin',
            'knowledge:policy',
            'knowledge:write',
            'read',
            'search:admin',
          ],
          idempotencyKey: 'admin-test-bootstrap-v1',
        },
      );
      const bootstrapReceipt = await commitAuthorizationBootstrapV1(
        bootstrapParticipant,
        await bootstrapOwner.seal(bootstrapParticipant, {}),
      );
      const cursorKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const port = await createWorkshopTaprootOperationPortV1({
        kind: 'workshop-taproot-assembly-v1',
        db: workshopDb,
        installationId,
        taprootOptions: taproot,
        hostAuthority,
        cursorCodec: createAuthorizationCursorCodec(cursorKey),
        async status() {
          throw new Error('unused');
        },
      });
      const context: OperationCallContext = {
        principal: {
          installationId,
          principalId: 'principal:owner',
          credentialId: 'credential:owner',
          activeWorkspaceId: 'workspace:admin-test',
          workspaceIds: ['workspace:admin-test'],
          capabilities: [
            'admin',
            'knowledge:policy',
            'knowledge:write',
            'read',
            'search:admin',
          ],
          authorizationRevision: bootstrapReceipt.authorizationRevision,
        },
        requestId: 'request:admin-test',
        signal: new AbortController().signal,
      };
      const operations = createOperationRuntime({
        version: '0.5.0',
        taproot: port,
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
      const admin = (input: Record<string, unknown>) =>
        operations.call('authorization_admin', input, context);
      const created = (await admin({
        version: 1,
        action: 'principal-create',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'principal-worker-v1',
        principal: { principalId: 'principal:worker', enabled: true },
      })) as { status: string; policyRevision: number };
      expect(created).toMatchObject({
        status: 'committed',
        target: { kind: 'principal', id: 'principal:worker' },
      });
      context.principal.authorizationRevision = created.policyRevision;
      await expect(
        admin({
          version: 1,
          action: 'principal-create',
          expectedPolicyRevision: bootstrapReceipt.authorizationRevision,
          idempotencyKey: 'principal-worker-v1',
          principal: { principalId: 'principal:worker', enabled: true },
        }),
      ).resolves.toMatchObject({ status: 'replayed' });
      await expect(
        admin({
          version: 1,
          action: 'principal-create',
          expectedPolicyRevision: bootstrapReceipt.authorizationRevision,
          idempotencyKey: 'principal-worker-v1',
          principal: { principalId: 'principal:other', enabled: true },
        }),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });

      const membershipAdded = (await admin({
        version: 1,
        action: 'workspace-membership-add',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'membership-worker-v1',
        principalId: 'principal:worker',
        workspaceId: 'workspace:admin-test',
      })) as { policyRevision: number };
      context.principal.authorizationRevision = membershipAdded.policyRevision;
      const grantAdded = (await admin({
        version: 1,
        action: 'workspace-grant-add',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'grant-worker-read-v1',
        principalId: 'principal:worker',
        workspaceId: 'workspace:admin-test',
        capability: 'read',
      })) as { policyRevision: number };
      context.principal.authorizationRevision = grantAdded.policyRevision;
      await expect(
        port.recheckPrincipal(
          {
            ...context.principal,
            principalId: 'principal:worker',
            credentialId: 'credential:worker',
            capabilities: [],
            workspaceIds: [],
          },
          context.signal,
        ),
      ).resolves.toMatchObject({
        principalId: 'principal:worker',
        workspaceIds: ['workspace:admin-test'],
        capabilities: expect.arrayContaining(['read']),
      });
      const entity = (await operations.call(
        'create_item',
        {
          idempotencyKey: 'authorization-visible-item-v1',
          authoredText: 'Create an item for bounded authorization testing.',
          data: {
            id: 'Q1',
            labels: {
              en: { language: 'en', value: 'Authorized visible item' },
            },
          },
        },
        context,
      )) as {
        entityId: string;
        newRevision: number;
      };
      context.principal = await port.recheckPrincipal(
        context.principal,
        context.signal,
      );
      let targetRevision = entity.newRevision;
      for (const [index, value] of [
        'Authorized visible item revision two',
        'Authorized visible item revision three',
      ].entries()) {
        const revised = (await operations.call(
          'mutate_entity',
          {
            entityId: entity.entityId,
            expectedRevision: targetRevision,
            idempotencyKey: `authorization-visible-item-revision-${index + 2}`,
            mutations: [
              {
                kind: 'label',
                authoredText: `Set the bounded authorization fixture label revision ${index + 2}.`,
                value: {
                  type: 'set-label',
                  language: 'en',
                  value,
                },
              },
            ],
          },
          context,
        )) as { newRevision: number };
        targetRevision = revised.newRevision;
        context.principal = await port.recheckPrincipal(
          context.principal,
          context.signal,
        );
      }
      expect(targetRevision).toBe(3);
      const visibilityInput = {
        version: 1,
        action: 'visibility-policy-set',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'visibility-worker-v1',
        target: { kind: 'entity', id: entity.entityId },
        expectedTargetRevision: targetRevision,
        visibility: {
          version: 1,
          clauses: [
            [{ kind: 'workspace', workspaceId: 'workspace:admin-test' }],
          ],
        },
      } as const;
      const visible = (await admin(visibilityInput)) as {
        policyRevision: number;
      };
      context.principal.authorizationRevision = visible.policyRevision;
      await expect(admin(visibilityInput)).resolves.toMatchObject({
        status: 'replayed',
        policyRevision: visible.policyRevision,
      });
      await expect(
        admin({
          version: 1,
          action: 'effective-policy',
          target: { kind: 'entity', id: entity.entityId },
        }),
      ).resolves.toMatchObject({
        action: 'effective-policy',
        policyRevision: visible.policyRevision,
        value: {
          target: { kind: 'entity', id: entity.entityId },
          sourceRevision: 4,
          sourcePolicyRevision: visible.policyRevision,
          visibility: visibilityInput.visibility,
        },
      });
      await expect(
        admin({
          ...visibilityInput,
          visibility: { version: 1, clauses: [] },
        }),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });
      const workerPrincipal = await port.recheckPrincipal(
        {
          ...context.principal,
          principalId: 'principal:worker',
          credentialId: 'credential:worker',
          capabilities: [],
          workspaceIds: [],
        },
        context.signal,
      );
      await expect(
        operations.call(
          'get_entity',
          { entityId: entity.entityId },
          { ...context, principal: workerPrincipal },
        ),
      ).resolves.toMatchObject({ entity: { id: entity.entityId } });

      const workerToken = Buffer.from(
        Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      ).toString('base64url');
      const workerDigest = await digestLocalBearerCredentialText(workerToken);
      const registered = (await admin({
        version: 1,
        action: 'credential-register',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'credential-worker-v1',
        credential: {
          credentialId: 'credential:worker',
          tokenDigest: workerDigest,
          principalId: 'principal:worker',
          workspaceId: 'workspace:admin-test',
        },
      })) as { policyRevision: number };
      context.principal.authorizationRevision = registered.policyRevision;
      await expect(
        workshopDb
          .prepare(
            `SELECT token_digest, disabled FROM workshop_credentials
             WHERE installation_id = ? AND credential_id = ?`,
          )
          .bind(installationId, 'credential:worker')
          .first(),
      ).resolves.toEqual({ token_digest: workerDigest, disabled: 0 });
      const credentialAudit = await workshopDb
        .prepare(
          `SELECT details_json FROM workshop_authorization_audit
           WHERE installation_id = ? AND action = 'credential-register'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(installationId)
        .first<{ details_json: string }>();
      expect(credentialAudit?.details_json).not.toContain(workerToken);
      expect(credentialAudit?.details_json).not.toContain(workerDigest);

      const credentialRevoked = (await admin({
        version: 1,
        action: 'credential-revoke',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'credential-worker-revoke-v1',
        credentialId: 'credential:worker',
      })) as { policyRevision: number };
      context.principal.authorizationRevision =
        credentialRevoked.policyRevision;
      await expect(
        workshopDb
          .prepare(
            `SELECT disabled FROM workshop_credentials
             WHERE installation_id = ? AND credential_id = ?`,
          )
          .bind(installationId, 'credential:worker')
          .first(),
      ).resolves.toEqual({ disabled: 1 });

      const registeredAgain = (await admin({
        version: 1,
        action: 'credential-register',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'credential-worker-reregister-v1',
        credential: {
          credentialId: 'credential:worker',
          tokenDigest: 'b'.repeat(64),
          principalId: 'principal:worker',
          workspaceId: 'workspace:admin-test',
        },
      })) as { policyRevision: number };
      context.principal.authorizationRevision = registeredAgain.policyRevision;

      const disabled = (await admin({
        version: 1,
        action: 'principal-disable',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'disable-worker-v1',
        principalId: 'principal:worker',
      })) as { policyRevision: number };
      context.principal.authorizationRevision = disabled.policyRevision;
      await expect(
        workshopDb
          .prepare(
            `SELECT disabled FROM workshop_credentials
             WHERE installation_id = ? AND credential_id = ?`,
          )
          .bind(installationId, 'credential:worker')
          .first(),
      ).resolves.toEqual({ disabled: 1 });
      await expect(
        port.recheckPrincipal(
          {
            ...context.principal,
            principalId: 'principal:worker',
            credentialId: 'credential:worker',
          },
          context.signal,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const enabled = (await admin({
        version: 1,
        action: 'principal-enable',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'enable-worker-v1',
        principalId: 'principal:worker',
      })) as { policyRevision: number };
      context.principal.authorizationRevision = enabled.policyRevision;
      const revoked = (await admin({
        version: 1,
        action: 'principal-revoke',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'revoke-worker-v1',
        principalId: 'principal:worker',
      })) as { policyRevision: number };
      context.principal.authorizationRevision = revoked.policyRevision;
      await expect(
        port.recheckPrincipal(workerPrincipal, context.signal),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const membershipRemoved = (await admin({
        version: 1,
        action: 'workspace-membership-remove',
        expectedPolicyRevision: context.principal.authorizationRevision,
        idempotencyKey: 'membership-worker-remove-v1',
        principalId: 'principal:worker',
        workspaceId: 'workspace:admin-test',
      })) as { policyRevision: number };
      context.principal.authorizationRevision =
        membershipRemoved.policyRevision;

      for (const [input, key] of [
        [
          {
            action: 'principal-create',
            principal: { principalId: 'principal:cleanup', enabled: true },
          },
          'cleanup-create',
        ],
        [
          {
            action: 'workspace-membership-add',
            principalId: 'principal:cleanup',
            workspaceId: 'workspace:admin-test',
          },
          'cleanup-membership-add',
        ],
        [
          {
            action: 'workspace-grant-add',
            principalId: 'principal:cleanup',
            workspaceId: 'workspace:admin-test',
            capability: 'read',
          },
          'cleanup-grant-add',
        ],
        [
          {
            action: 'workspace-grant-remove',
            principalId: 'principal:cleanup',
            workspaceId: 'workspace:admin-test',
            capability: 'read',
          },
          'cleanup-grant-remove',
        ],
        [
          {
            action: 'workspace-membership-remove',
            principalId: 'principal:cleanup',
            workspaceId: 'workspace:admin-test',
          },
          'cleanup-membership-remove',
        ],
        [
          { action: 'principal-revoke', principalId: 'principal:cleanup' },
          'cleanup-revoke',
        ],
      ] as const) {
        const result = (await admin({
          version: 1,
          ...input,
          expectedPolicyRevision: context.principal.authorizationRevision,
          idempotencyKey: key,
        })) as { policyRevision: number };
        context.principal.authorizationRevision = result.policyRevision;
      }
      await expect(
        admin({ version: 1, action: 'status' }),
      ).resolves.toMatchObject({
        action: 'status',
        value: { principals: 2, credentials: 1, audits: 17 },
      });
      await expect(
        port.recheckPrincipal(context.principal, context.signal),
      ).resolves.toMatchObject({ principalId: 'principal:owner' });
    } finally {
      await db.close();
    }
  });

  it('commits complete statement, qualifier, reference, and rank mutations through the sealed Taproot port', async () => {
    const path = join(tmpdir(), `workshop-mutation-${randomUUID()}.sqlite`);
    paths.push(path);
    const db = new NodeSqliteDatabase(path);
    const workshopDb = db as unknown as D1DatabaseLike;
    const taproot = { baseIri: 'https://workshop-mutation.test/' };
    const installationId = 'installation:mutation-test';
    try {
      await initializeTaproot(db, taproot);
      await applyWorkshopMigrations(workshopDb);
      const hostKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hostAuthority = createTaprootHostWriteCapability(
        db,
        taproot,
        hostKey,
      );
      await bootstrapTaprootAuthorization(
        db,
        taproot,
        hostAuthority,
        installationId,
      );
      const cursorKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const port = await createWorkshopTaprootOperationPortV1({
        kind: 'workshop-taproot-assembly-v1',
        db: workshopDb,
        installationId,
        taprootOptions: taproot,
        hostAuthority,
        cursorCodec: createAuthorizationCursorCodec(cursorKey),
        async status() {
          throw new Error('unused');
        },
      });
      const context = {
        principal: {
          installationId,
          principalId: 'agent:mutation-author',
          credentialId: 'credential:mutation-author',
          activeWorkspaceId: 'workspace:mutation-test',
          workspaceIds: ['workspace:mutation-test'],
          capabilities: [
            'read',
            'knowledge:write',
            'knowledge:policy',
            'admin',
          ],
          authorizationRevision: 1,
        },
        requestId: 'request:mutation-test',
        signal: new AbortController().signal,
      };
      const property = (await port.call(
        'create_property',
        {
          idempotencyKey: 'property-name-v1',
          authoredText: 'Create a string property.',
          data: {
            id: 'P1',
            datatype: 'string',
            labels: { en: { language: 'en', value: 'Name' } },
          },
        },
        context,
      )) as { authorizationRevision: number };
      context.principal.authorizationRevision = property.authorizationRevision;
      const item = (await port.call(
        'create_item',
        {
          idempotencyKey: 'item-subject-v1',
          authoredText: 'Create a mutation subject.',
          data: {
            id: 'Q1',
            labels: { en: { language: 'en', value: 'Subject' } },
          },
        },
        context,
      )) as { authorizationRevision: number };
      context.principal.authorizationRevision = item.authorizationRevision;
      const beforeNoop = await workshopDb
        .prepare(
          `SELECT authorization_revision, search_generation
           FROM taproot_installation_authorization
           WHERE singleton = 1 AND installation_id = ?`,
        )
        .bind(installationId)
        .first<{
          authorization_revision: number;
          search_generation: number;
        }>();
      const sourceEventsBefore = Number(
        (
          await workshopDb
            .prepare(
              `SELECT COUNT(*) AS count
               FROM taproot_unified_search_source_events
               WHERE installation_id = ?`,
            )
            .bind(installationId)
            .first<{ count: number }>()
        )?.count ?? 0,
      );
      const identicalMutations = await Promise.all(
        ['concurrent-a', 'concurrent-b'].map((suffix) =>
          port.call(
            'mutate_entity',
            {
              entityId: 'Q1',
              expectedRevision: 1,
              idempotencyKey: `item-identical-label-${suffix}`,
              mutations: [
                {
                  kind: 'label',
                  authoredText: 'Preserve the identical subject label.',
                  value: {
                    type: 'set-label',
                    language: 'en',
                    value: 'Subject',
                  },
                },
              ],
            },
            context,
          ),
        ),
      );
      for (const identical of identicalMutations)
        expect(identical).toMatchObject({
          changed: false,
          previousRevision: 1,
          newRevision: 1,
          quadPatch: { deleted: 0, inserted: 0 },
          authorizationRevision: item.authorizationRevision,
        });
      await expect(
        workshopDb
          .prepare(
            `SELECT authorization_revision, search_generation
             FROM taproot_installation_authorization
             WHERE singleton = 1 AND installation_id = ?`,
          )
          .bind(installationId)
          .first(),
      ).resolves.toEqual(beforeNoop);
      await expect(
        workshopDb
          .prepare(
            `SELECT COUNT(*) AS count
             FROM taproot_unified_search_source_events
             WHERE installation_id = ?`,
          )
          .bind(installationId)
          .first(),
      ).resolves.toEqual({ count: sourceEventsBefore });
      const statementId = 'Q1$statement-1';
      const valueSnak = {
        snaktype: 'value',
        property: 'P1',
        datatype: 'string',
        datavalue: { value: 'Ada', type: 'string' },
      };
      const added = (await port.call(
        'mutate_entity',
        {
          entityId: 'Q1',
          expectedRevision: 1,
          idempotencyKey: 'item-statement-v1',
          mutations: [
            {
              kind: 'statement',
              authoredText: 'State the subject name.',
              value: {
                type: 'add-statement',
                statement: {
                  id: statementId,
                  type: 'statement',
                  text: 'State the subject name.',
                  rank: 'normal',
                  mainsnak: valueSnak,
                  qualifiers: {},
                  'qualifiers-order': [],
                  references: [],
                },
              },
            },
          ],
        },
        context,
      )) as {
        newRevision: number;
        quadPatch: { inserted: number };
      };
      expect(added.newRevision).toBe(2);
      expect((added as typeof added & { changed: boolean }).changed).toBe(true);
      expect(added.quadPatch.inserted).toBeGreaterThan(0);
      context.principal.authorizationRevision = (
        added as typeof added & { authorizationRevision: number }
      ).authorizationRevision;

      const reference = {
        hash: 'reference-1',
        snaks: {
          P1: [
            { ...valueSnak, datavalue: { value: 'Source', type: 'string' } },
          ],
        },
        'snaks-order': ['P1'],
      };
      const revised = (await port.call(
        'mutate_entity',
        {
          entityId: 'Q1',
          expectedRevision: 2,
          idempotencyKey: 'item-statement-detail-v1',
          mutations: [
            {
              kind: 'qualifier',
              authoredText: 'Qualify the subject name.',
              value: {
                type: 'add-qualifier',
                statementId,
                snak: {
                  ...valueSnak,
                  datavalue: { value: 'Primary', type: 'string' },
                },
                text: 'Qualify the subject name.',
              },
            },
            {
              kind: 'reference',
              authoredText: 'Reference the subject name.',
              value: {
                type: 'add-reference',
                statementId,
                reference,
                text: 'Reference the subject name.',
              },
            },
            {
              kind: 'rank',
              authoredText: 'Prefer the sourced subject name.',
              value: {
                type: 'set-statement-rank',
                statementId,
                rank: 'preferred',
                text: 'Prefer the sourced subject name.',
              },
            },
          ],
        },
        context,
      )) as {
        newRevision: number;
        entity: {
          claims: Record<
            string,
            Array<{
              rank: string;
              qualifiers: Record<string, unknown[]>;
              references: Array<{ hash: string }>;
            }>
          >;
        };
        quadPatch: { deleted: number; inserted: number };
      };
      expect(revised.newRevision).toBe(3);
      expect(revised.entity.claims.P1?.[0]).toMatchObject({
        rank: 'preferred',
        qualifiers: { P1: [expect.any(Object)] },
        references: [{ hash: 'reference-1' }],
      });
      expect(
        revised.quadPatch.deleted + revised.quadPatch.inserted,
      ).toBeGreaterThan(0);
      context.principal.authorizationRevision = (
        revised as typeof revised & { authorizationRevision: number }
      ).authorizationRevision;
      await expect(
        port.call('entity_history', { entityId: 'Q1' }, context),
      ).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ revision: 1 }),
          expect.objectContaining({ revision: 2 }),
          expect.objectContaining({ revision: 3 }),
        ]),
      });
      await expect(
        port.call('statement_history', { statementId }, context),
      ).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ entityRevision: 2 }),
          expect.objectContaining({ entityRevision: 3 }),
        ]),
      });
    } finally {
      await db.close();
    }
  });

  it('adopts more than 1,000 legacy rows in bounded pages and restores producers after restart', async () => {
    const path = join(
      tmpdir(),
      `workshop-search-volume-${randomUUID()}.sqlite`,
    );
    paths.push(path);
    let db = new NodeSqliteDatabase(path);
    const taproot = { baseIri: 'https://workshop-search-volume.test' };
    const installationId = 'installation:search-volume';
    const context: AuthorizationContext = {
      installationId,
      principalId: 'agent:volume-admin',
      activeWorkspaceId: 'workspace:search-volume',
      workspaceIds: ['workspace:search-volume'],
      capabilities: ['read', 'search:admin', 'admin'],
      authorizationRevision: 1,
    };
    const key = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    try {
      await initializeTaproot(db, taproot);
      let workshopDb = db as unknown as D1DatabaseLike;
      await applyWorkshopMigrations(workshopDb);
      let hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      await bootstrapTaprootAuthorization(
        db,
        taproot,
        hostCapability,
        installationId,
      );
      const visibility = JSON.stringify({
        version: 1,
        clauses: [
          [{ kind: 'workspace', workspaceId: 'workspace:search-volume' }],
        ],
      });
      for (let offset = 0; offset < 1_001; offset += 80) {
        const statements = Array.from(
          { length: Math.min(80, 1_001 - offset) },
          (_, index) => {
            const suffix = String(offset + index).padStart(4, '0');
            return workshopDb
              .prepare(
                `INSERT INTO workshop_tasks
                 (id, title, description, prompt, installation_id, owner_principal_id,
                  workspace_id, visibility_scope, authorization_revision)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                `legacy-${suffix}`,
                `Legacy task ${suffix}`,
                `Legacy searchable task ${suffix}`,
                `Process legacy task ${suffix}`,
                installationId,
                context.principalId,
                context.activeWorkspaceId,
                visibility,
                context.authorizationRevision,
              );
          },
        );
        await workshopDb.batch(statements);
      }
      let search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
      });
      await expect(
        search.task.producer.adoptLegacyPage(
          { ...context, capabilities: ['read'] },
          { limit: 100 },
        ),
      ).rejects.toBeDefined();
      let pages = 0;
      let adopted = 0;
      let complete = false;
      let cursor: string | null = null;
      while (!complete) {
        const receipt = await search.task.producer.adoptLegacyPage(context, {
          cursor,
          limit: 100,
        });
        pages += 1;
        adopted += receipt.adopted;
        complete = receipt.complete;
        cursor = receipt.cursor;
        expect(pages).toBeLessThanOrEqual(11);
      }
      expect(adopted).toBe(1_001);
      expect(pages).toBe(11);

      await db.close();
      db = new NodeSqliteDatabase(path);
      workshopDb = db as unknown as D1DatabaseLike;
      hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
      });
      await expect(
        search.task.currentPredecessor('legacy-0000', context),
      ).resolves.toMatchObject({
        eventId: expect.stringMatching(/^external-adoption-event-/u),
        sequence: expect.any(Number),
      });
      await expect(
        search.materialization.health(context),
      ).resolves.toBeDefined();
      await expect(
        search.search(
          { text: 'legacy', limit: 10 },
          { ...context, installationId: 'installation:forged' },
        ),
      ).rejects.toBeDefined();
    } finally {
      await db.close();
    }
  });

  it('indexes, searches, hydrates, revises, and deletes a canonical Prompt on native SQLite', async () => {
    const path = join(tmpdir(), `workshop-search-${randomUUID()}.sqlite`);
    paths.push(path);
    const db = new NodeSqliteDatabase(path);
    const workshopDb = db as unknown as D1DatabaseLike;
    const taproot = { baseIri: 'https://workshop-search.test' };
    const installationId = 'installation:search-test';
    try {
      await initializeTaproot(db, taproot);
      await applyWorkshopMigrations(workshopDb);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hostCapability = createTaprootHostWriteCapability(db, taproot, key);
      await bootstrapTaprootAuthorization(
        db,
        taproot,
        hostCapability,
        installationId,
      );
      const context: AuthorizationContext = {
        installationId,
        principalId: 'agent:prompt-author',
        activeWorkspaceId: 'workspace:search-test',
        workspaceIds: ['workspace:search-test'],
        capabilities: [
          'read',
          'task:write',
          'memory:write',
          'prompt:write',
          'search:admin',
          'admin',
        ],
        authorizationRevision: 1,
      };
      let searchTick = Date.parse('2026-07-23T12:00:00.000Z');
      const search = await createWorkshopSearchIntegrationV1({
        db: workshopDb,
        taproot,
        hostCapability,
        installationId,
        registrationContext: context,
        clock: () => new Date(searchTick),
      });
      for (const domain of [search.task, search.memory, search.prompt]) {
        await expect(
          domain.producer.adoptLegacyPage(context, { limit: 100 }),
        ).resolves.toMatchObject({ complete: true });
      }
      const authority: WorkshopAuthorizationAuthority = {
        async getInstallationAuthorizationState() {
          return {
            installationId,
            authorizationRevision: 1,
            searchGeneration: 1,
          };
        },
        async commitTaskMutation<T>(
          _db: D1DatabaseLike,
          actor: AuthorizationContext,
          statement: D1PreparedStatementLike,
        ) {
          if (!actor.capabilities.includes('task:write'))
            throw new Error('denied');
          return statement.first<T>();
        },
        async commitMemoryMutation<T>(
          _db: D1DatabaseLike,
          actor: AuthorizationContext,
          statement: D1PreparedStatementLike,
        ) {
          if (!actor.capabilities.includes('memory:write'))
            throw new Error('denied');
          return statement.first<T>();
        },
        async commitTaskBackfill(_db, _actor, _state, statements) {
          return _db.batch([...statements]);
        },
        async commitMemoryBackfill(_db, _actor, _state, statements) {
          return _db.batch([...statements]);
        },
        async commitCursorSnapshot(_db, actor, _state, statements) {
          if (!actor.capabilities.includes('read')) throw new Error('denied');
          return _db.batch([...statements]);
        },
      };
      const core = createWorkshopCore({
        persistence: workshopDb,
        authorization: authority,
        knowledge: createTestKnowledgeOptions(),
        cursorCodec: createTestCursorCodec(),
        diamondHealth: async () => true,
        search,
      });
      const memory = await core.memories.upsert(
        'merge-guidance',
        {
          description: 'Merge guidance',
          content: 'Prefer atomic producer commits.',
        },
        context,
      );
      const memory2 = await core.memories.upsert(
        memory.slug,
        {
          description: memory.description,
          content: 'Prefer sealed atomic producer commits.',
          expectedRevision: memory.revision,
        },
        context,
      );
      expect(memory2.revision).toBe(2);
      expect(await core.memories.history(memory.slug, context)).toHaveLength(2);
      const idempotent = await core.memories.putIdempotent(
        'stable-guide',
        { description: 'Stable guide', content: 'Replay safely.' },
        context,
        'stable-guide-v1',
      );
      await expect(
        core.memories.putIdempotent(
          'stable-guide',
          { description: 'Stable guide', content: 'Replay safely.' },
          context,
          'stable-guide-v1',
        ),
      ).resolves.toMatchObject({ revision: 1 });
      const task = await core.tasks.create(
        {
          description: 'Review producer changes',
          prompt: 'Review atomically.',
        },
        context,
      );
      const editedTask = await core.tasks.update(
        task.id,
        { expectedRevision: 1, title: 'Review sealed producer changes' },
        context,
      );
      const claimedTask = await core.tasks.claim(editedTask.id, context);
      const completedTask = await core.tasks.complete(
        claimedTask.id,
        { kind: 'success', result: 'Reviewed.' },
        context,
      );
      expect(completedTask.revision).toBe(4);
      expect(await core.tasks.history(task.id, context)).toHaveLength(4);
      const archivedTask = await core.tasks.create(
        { description: 'Archive producer changes', prompt: 'Archive safely.' },
        context,
      );
      await expect(
        core.tasks.archive(archivedTask.id, { expectedRevision: 1 }, context),
      ).resolves.toMatchObject({ archivedAt: expect.any(String) });
      const abandonedTask = await core.tasks.create(
        {
          description: 'Reset abandoned producer claim',
          prompt: 'Reset safely.',
        },
        context,
      );
      await core.tasks.claim(abandonedTask.id, context);
      await expect(
        core.tasks.resetAbandonedClaim(
          abandonedTask.id,
          new Date(Date.now() + 60_000).toISOString(),
          context,
        ),
      ).resolves.toMatchObject({ claimed: false });
      await core.memories.delete(idempotent.slug, 1, context);
      const prompt = await core.prompts!.create(
        {
          name: 'merge-review',
          title: 'Merge review prompt',
          promptText: 'Compare overlapping work and recommend a safe merge.',
          scope: 'task-review',
          role: 'reviewer',
          variables: { taskIds: { type: 'array' } },
          priority: 20,
          order: 3,
        },
        context,
      );
      expect(prompt).toMatchObject({
        revision: 1,
        policyRevision: 1,
        active: true,
      });
      let completed = 0;
      for (let page = 0; page < 10; page += 1) {
        const receipt = await search.materialization.run(context, {
          maxJobs: 20,
          maxRebuildRoots: 20,
        });
        completed += receipt.completed;
        searchTick += 60_000;
      }
      expect(completed).toBeGreaterThanOrEqual(1);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      const first = await search.search(
        { text: 'overlapping work', kinds: ['prompt'], limit: 10 },
        context,
      );
      expect(first.results).toHaveLength(1);
      expect(first.results[0]).toMatchObject({
        kind: 'prompt',
        sourceId: prompt.id,
        sourceRevision: '1',
      });
      const cursorKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const operationPort = await createWorkshopTaprootOperationPortV1({
        kind: 'workshop-taproot-assembly-v1',
        db: workshopDb,
        installationId,
        taprootOptions: taproot,
        hostAuthority: hostCapability,
        cursorCodec: createAuthorizationCursorCodec(cursorKey),
        search: search.service,
        semantic: search.semantic,
        async status() {
          throw new Error('unused');
        },
      });
      const operationContext = {
        principal: {
          ...context,
          credentialId: 'credential:search-test',
        },
        requestId: 'request:search-test',
        signal: new AbortController().signal,
      };
      await expect(
        operationPort.call(
          'search',
          { text: 'overlapping work', kinds: ['prompt'], limit: 10 },
          operationContext,
        ),
      ).resolves.toMatchObject({
        items: [
          {
            kind: 'prompt',
            id: prompt.id,
            revision: 1,
          },
        ],
      });
      await expect(
        operationPort.call(
          'search',
          { text: 'overlapping work', cursor: 'forged-cursor', limit: 2 },
          operationContext,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_cursor',
        status: 400,
        message: 'Search cursor is invalid',
      });
      await expect(
        operationPort.call(
          'search_admin',
          { action: 'health' },
          operationContext,
        ),
      ).resolves.toHaveProperty('materialization');
      await expect(
        operationPort.call(
          'search_admin',
          { action: 'materialize', limit: 1_000 },
          operationContext,
        ),
      ).resolves.toHaveProperty('completed');
      await expect(
        search.search(
          { text: 'overlapping work', kinds: ['prompt'], limit: 10 },
          {
            ...context,
            activeWorkspaceId: 'workspace:other',
            workspaceIds: ['workspace:other'],
          },
        ),
      ).resolves.toMatchObject({ results: [] });
      await expect(
        search.service.hydrate(first.results[0]!, context),
      ).resolves.toMatchObject({
        id: prompt.id,
        name: 'merge-review',
        revision: 1,
      });
      const changed = await core.prompts!.update(
        prompt.id,
        {
          expectedRevision: 1,
          promptText: 'Split unsafe work, then merge only compatible tasks.',
        },
        context,
      );
      expect(changed.revision).toBe(2);
      await expect(
        core.prompts!.update(
          prompt.id,
          { expectedRevision: 1, title: 'Stale write' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        search.service.hydrate(first.results[0]!, context),
      ).rejects.toBeDefined();
      expect(await core.prompts!.history(prompt.id, context)).toHaveLength(2);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      expect(
        (
          await search.search(
            { text: 'unsafe work', kinds: ['prompt'] },
            context,
          )
        ).results[0],
      ).toMatchObject({ sourceRevision: '2' });
      await core.prompts!.delete(prompt.id, 2, context);
      await search.materialization.run(context, {
        maxJobs: 20,
        maxRebuildRoots: 20,
      });
      await expect(core.prompts!.get(prompt.id, context)).rejects.toMatchObject(
        {
          code: 'forbidden',
        },
      );
      expect(
        (
          await search.search(
            { text: 'unsafe work', kinds: ['prompt'] },
            context,
          )
        ).results,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
