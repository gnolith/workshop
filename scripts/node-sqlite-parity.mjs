import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'workshop-packed-parity-'));
const npmCli = findNpmCli();
try {
  const diamondTarball = artifact(
    'DIAMOND_TARBALL',
    resolve('..', 'diamond', 'gnolith-diamond-0.5.0.tgz'),
    process.env.DIAMOND_TARBALL_SHA256 ??
      '3ce5d33478667dc4ec9a8ae4b4c3e0a94c3bce61e741ba62511ab668d1c20228',
  );
  const taprootTarball = artifact(
    'TAPROOT_TARBALL',
    resolve('..', 'taproot', 'gnolith-taproot-0.5.0.tgz'),
    process.env.TAPROOT_TARBALL_SHA256 ??
      '322c54ce4c604c73b86935a33d1980a96b75ca3dd5fde0671fba70b9681ecc41',
  );
  const [packed] = JSON.parse(
    execFileSync(
      process.execPath,
      [npmCli, 'pack', '--json', '--pack-destination', root],
      { cwd: process.cwd(), encoding: 'utf8' },
    ),
  );
  const workshopTarball = join(root, packed.filename);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  execFileSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-save',
      diamondTarball,
      taprootTarball,
      workshopTarball,
      'typescript@5.9.2',
      '@types/node@24',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  writeFileSync(join(root, 'consumer.mjs'), consumerScript());
  execFileSync(process.execPath, [join(root, 'consumer.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  writeFileSync(join(root, 'consumer.ts'), declarationConsumer());
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          types: ['node'],
          exactOptionalPropertyTypes: true,
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc')],
    { cwd: root, stdio: 'inherit' },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

function artifact(environmentName, fallback, expectedSha256) {
  const path = resolve(process.env[environmentName] ?? fallback);
  assert.equal(
    sha256(readFileSync(path)),
    expectedSha256,
    `${environmentName} SHA-256 does not match the exact candidate`,
  );
  return path;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(
      process.execPath,
      '..',
      '..',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => {
    try {
      return readFileSync(candidate).length > 0;
    } catch {
      return false;
    }
  });
  assert.ok(cli, 'npm CLI was not found');
  return cli;
}

function consumerScript() {
  return String.raw`
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { workshopPackage } from '@gnolith/workshop';
import {
  bootstrapWorkshopV1,
  createWorkshopBootstrapOwnerAdapterV1,
} from '@gnolith/workshop/bootstrap';
import {
  createLocalFilesystemResourceBlobPortsV1,
} from '@gnolith/workshop/backup';
import {
  applyWorkshopMigrations,
  WORKSHOP_SCHEMA_VERSION,
} from '@gnolith/workshop/migrations';

assert.equal(workshopPackage.version, '0.5.0');
assert.equal(workshopPackage.schemaVersion, 11);
assert.equal(WORKSHOP_SCHEMA_VERSION, 11);
const temporary = await mkdtemp(join(tmpdir(), 'workshop-consumer-'));
const path = join(temporary, 'shared.sqlite');
const baseIri = 'https://packed-parity.example';
const installationId = 'installation:packed-parity';
let db = new NodeSqliteDatabase(path);
try {
  await initializeTaproot(db, { baseIri });
  assert.deepEqual(await applyWorkshopMigrations(db), {
    previousVersion: 0,
    version: 11,
    applied: [
      '0001_workshop', '0002_revisions', '0003_resumable_onboarding',
      '0004_authorization', '0005_cursor_snapshots',
      '0006_canonical_search_domains', '0007_task_leases',
      '0008_bootstrap_credentials',
      '0009_operation_receipts',
      '0010_durable_mutation_receipts',
      '0011_administration_control_plane',
    ],
  });
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const authority = createTaprootHostWriteCapability(db, { baseIri }, key);
  const ownerAdapter = createWorkshopBootstrapOwnerAdapterV1(db);
  const issuer = await registerAuthorizationBootstrapOwnerV1(
    db, { baseIri }, authority,
    { installationId, ownerRegistrationId: 'workshop', adapter: ownerAdapter.adapter },
  );
  const raw = randomBytes(32);
  const credentialFile = new TextEncoder().encode(raw.toString('base64url'));
  const receipt = await bootstrapWorkshopV1(
    {
      version: 1, installationId, baseIri,
      principalId: 'principal:owner', workspaceId: 'workspace:default',
      credential: { kind: 'file', value: '/protected' },
      idempotencyKey: 'packed-owner-v1', profile: 'local-bearer-v1',
    },
    {
      prepareAuthorizationBootstrapV1: (input) =>
        prepareAuthorizationBootstrapV1(db, { baseIri }, authority, input),
      ownerParticipantIssuer: issuer,
      ownerAdapter,
      commitAuthorizationBootstrapV1,
      readProtectedCredential: async () => credentialFile.slice(),
      workshopSchemaVersion: 11,
    },
  );
  assert.equal(receipt.installationId, installationId);
  const blobRoot = join(temporary, 'blobs');
  const blobs = await createLocalFilesystemResourceBlobPortsV1({ root: blobRoot });
  const bytes = new TextEncoder().encode('packed payload');
  const descriptor = {
    referenceId: 'blob:packed', resourceId: 'resource:packed', revision: 1,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/plain',
  };
  const stage = await blobs.restore.stage(
    descriptor,
    new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  );
  await blobs.restore.verify(stage);
  await blobs.restore.commit([stage]);
  assert.deepEqual((await blobs.backup.enumerate(null, 10)).items, [descriptor]);
  await db.close();
  db = new NodeSqliteDatabase(path);
  assert.deepEqual(await applyWorkshopMigrations(db), {
    previousVersion: 11, version: 11, applied: [],
  });
} finally {
  await db.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
`;
}

function declarationConsumer() {
  return `
import type {
  ResourceBlobBackupPort,
  ResourceBlobRestorePort,
} from '@gnolith/taproot/backup';
import {
  createLocalFilesystemResourceBlobPortsV1,
  type LocalFilesystemResourceBlobPortsV1,
} from '@gnolith/workshop/backup';
import {
  createWorkshopCanonicalOwnerAdapterV1,
  type WorkshopSearchDomainV1,
} from '@gnolith/workshop/server';

async function consume(): Promise<void> {
  const ports: LocalFilesystemResourceBlobPortsV1 =
    await createLocalFilesystemResourceBlobPortsV1({ root: '/absolute/blobs' });
  const backup: ResourceBlobBackupPort = ports.backup;
  const restore: ResourceBlobRestorePort = ports.restore;
  void backup;
  void restore;
  void createWorkshopCanonicalOwnerAdapterV1;
  const domain: WorkshopSearchDomainV1 | null = null;
  void domain;
}
void consume;
`;
}
