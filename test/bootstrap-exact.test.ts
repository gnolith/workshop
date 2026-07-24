import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  commitAuthorizationBootstrapV1,
  createTaprootHostWriteCapability,
  initializeTaproot,
  prepareAuthorizationBootstrapV1,
  registerAuthorizationBootstrapOwnerV1,
} from '@gnolith/taproot';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapWorkshopV1,
  createWorkshopBootstrapOwnerAdapterV1,
} from '../src/bootstrap.js';
import { applyWorkshopMigrations } from '../src/migrations.js';
import type { D1DatabaseLike } from '../src/server/database.js';
import { createWorkshopLocalBearerCredentialStoreV1 } from '../src/server/auth.js';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe('exact Taproot authorization bootstrap owner', () => {
  it('seals Workshop credential statements and commits one replay-safe receipt', async () => {
    const path = join(tmpdir(), `workshop-bootstrap-${randomUUID()}.sqlite`);
    paths.push(path);
    const db = new NodeSqliteDatabase(path);
    const workshopDb = db as unknown as D1DatabaseLike;
    const baseIri = 'https://workshop-bootstrap.test';
    const installationId = 'installation:bootstrap';
    try {
      await initializeTaproot(db, { baseIri });
      await applyWorkshopMigrations(workshopDb);
      const key = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const authority = createTaprootHostWriteCapability(db, { baseIri }, key);
      const ownerAdapter = createWorkshopBootstrapOwnerAdapterV1(workshopDb);
      const issuer = await registerAuthorizationBootstrapOwnerV1(
        db,
        { baseIri },
        authority,
        {
          installationId,
          ownerRegistrationId: 'workshop',
          adapter: ownerAdapter.adapter,
        },
      );
      const credential = crypto.getRandomValues(new Uint8Array(32));
      const credentialFile = new TextEncoder().encode(
        `${Buffer.from(credential).toString('base64url')}\n`,
      );
      const receipt = await bootstrapWorkshopV1(
        {
          version: 1,
          installationId,
          baseIri,
          principalId: 'principal:owner',
          workspaceId: 'workspace:default',
          credential: { kind: 'file', value: '/protected/token' },
          idempotencyKey: 'initial-owner-v1',
          profile: 'local-bearer-v1',
        },
        {
          prepareAuthorizationBootstrapV1: (input) =>
            prepareAuthorizationBootstrapV1(db, { baseIri }, authority, input),
          ownerParticipantIssuer: issuer,
          ownerAdapter,
          commitAuthorizationBootstrapV1,
          async readProtectedCredential() {
            return credentialFile.slice();
          },
          workshopSchemaVersion: 9,
          clock: () => new Date('2026-07-23T12:00:00.000Z'),
        },
      );
      expect(receipt).toMatchObject({
        version: 1,
        installationId,
        principalId: 'principal:owner',
        workspaceId: 'workspace:default',
        workshopSchemaVersion: 9,
        replayed: false,
      });
      expect(receipt.credentialDigest).toMatch(/^[a-f0-9]{64}$/u);
      await expect(
        workshopDb
          .prepare(
            `SELECT credential_id, token_digest, principal_id, workspace_id
             FROM workshop_credentials WHERE installation_id = ?`,
          )
          .bind(installationId)
          .first(),
      ).resolves.toMatchObject({
        credential_id: receipt.credentialId,
        token_digest: receipt.credentialDigest,
        principal_id: receipt.principalId,
        workspace_id: receipt.workspaceId,
      });
      await expect(
        workshopDb
          .prepare(
            `SELECT idempotency_key, grant_manifest_digest
             FROM workshop_bootstrap_receipts WHERE installation_id = ?`,
          )
          .bind(installationId)
          .first(),
      ).resolves.toMatchObject({
        idempotency_key: 'initial-owner-v1',
        grant_manifest_digest: receipt.grantManifestDigest,
      });
      expect(() => ownerAdapter.adapter.prepare({})).toThrow(
        /token is invalid/u,
      );
      const store = createWorkshopLocalBearerCredentialStoreV1(workshopDb, {
        async resolve() {
          return { capabilities: ['admin', 'read'], authorizationRevision: 1 };
        },
      });
      await expect(
        store.findByDigest(
          receipt.credentialDigest,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        credentialId: receipt.credentialId,
        capabilities: ['admin', 'read'],
        authorizationRevision: 1,
        disabled: false,
      });
    } finally {
      await db.close();
    }
  });
});
