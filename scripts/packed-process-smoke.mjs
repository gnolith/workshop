/* global fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
);
const tarball = resolve(root, packed[0].filename);
const fixture = mkdtempSync(join(tmpdir(), 'gnolith-workshop-process-'));
let child;
let semanticMock;
let semanticMockPoints;
try {
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@gnolith/workshop': `file:${tarball}`,
        '@gnolith/diamond': `file:${resolve(root, '..', 'diamond', 'gnolith-diamond-0.5.0.tgz')}`,
        '@gnolith/taproot': `file:${resolve(root, '..', 'taproot-artifacts', 'gnolith-taproot-0.5.0.tgz')}`,
      },
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts'], {
    cwd: fixture,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  const semanticMockRuntime = await startSemanticMock();
  semanticMock = semanticMockRuntime.server;
  semanticMockPoints = semanticMockRuntime.points;
  const semanticMockOrigin = semanticMockRuntime.origin;
  const token = Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  ).toString('base64url');
  const port = await availablePort();
  await writeFile(
    join(fixture, 'adapter.mjs'),
    `
import { Buffer } from 'node:buffer';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createWorkshopLocalExecutableAdapterFromPrimitivesV1,
} from '@gnolith/workshop/local-adapter';
import { verifyWaystoneAssetMount } from '@gnolith/workshop/server';
import {
  applyWorkshopMigrations,
} from '@gnolith/workshop/migrations';
import {
  createWorkshopBackupApi,
  createLocalFilesystemResourceBlobPortsV1,
} from '@gnolith/workshop/backup';
import {
  createMigrationAssemblyAuthorityV1,
  migrateDiamondStore,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  createAuthorizationCursorCodec,
  createTaprootHostWriteCapability,
  initializeTaproot,
} from '@gnolith/taproot';

assertFactory(createWorkshopLocalExecutableAdapterFromPrimitivesV1);
function assertFactory(value) {
  if (typeof value !== 'function') throw new Error('packed local adapter factory is unavailable');
}

const token = Buffer.from(
  Uint8Array.from({ length: 32 }, (_, index) => index),
).toString('base64url');
const installationId = 'installation:packed';
const baseIri = 'https://packed.invalid/';
const db = new NodeSqliteDatabase(
  fileURLToPath(new URL('./shared.sqlite', import.meta.url)),
);
await migrateDiamondStore(db);
await initializeTaproot(db, { baseIri });
await applyWorkshopMigrations(db);
const hostKey = await crypto.subtle.generateKey(
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
);
const hostAuthority = createTaprootHostWriteCapability(
  db, { baseIri }, hostKey,
);
const taprootCursorKey = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
);
const workshopCursorKey = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
);
const workshopDigestKey = await crypto.subtle.generateKey(
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
);
const blobs = await createLocalFilesystemResourceBlobPortsV1({
  root: fileURLToPath(new URL('./blobs', import.meta.url)),
});
const adapter = await createWorkshopLocalExecutableAdapterFromPrimitivesV1({
  kind: 'workshop-local-assembly-primitives-v1',
  version: '0.5.0',
  db,
  installationId,
  registrationFingerprint: 'd'.repeat(64),
  taproot: {
    options: { baseIri },
    hostAuthority,
    authorizationCursorCodec: createAuthorizationCursorCodec(taprootCursorKey),
    registrationPrincipal: {
      principalId: 'principal:packed',
      activeWorkspaceId: 'workspace:packed',
    },
    payloadStore: blobs.payloadStore,
  },
  cursor: {
    generation: 'packed-generation-v1',
    encryptionKey: workshopCursorKey,
    digestKey: workshopDigestKey,
  },
  migrationAssemblyAuthority:
    createMigrationAssemblyAuthorityV1(db, installationId),
  semantic: {
    resolveCredential(selector) {
      if (selector === 'provider:packed') return 'packed-openai-secret';
      if (selector === 'qdrant:packed') return 'packed-qdrant-secret';
      return undefined;
    },
  },
  assets: async (config) => {
    if (!config.assetMount) return undefined;
    const root = fileURLToPath(new URL('./assets/', import.meta.url));
    const manifest = JSON.parse(
      await readFile(new URL('./asset-manifest.json', import.meta.url), 'utf8'),
    );
    return verifyWaystoneAssetMount({
      prefix: config.assetMount.prefix,
      manifest,
      source: {
        async read(path) {
          const target = new URL(path, new URL('./assets/', import.meta.url));
          const metadata = await lstat(target).catch(() => null);
          if (!metadata) return null;
          return { bytes: await readFile(target), symlink: metadata.isSymbolicLink() };
        },
      },
    });
  },
  dependencies: [{ close: () => db.close() }],
});
export async function inspectOwnWorkshopState() {
  const state = await adapter.ownerHandles.owner.exportOwnedState({
    installationId,
    signal: new AbortController().signal,
  });
  const roundTrippedState = JSON.parse(JSON.stringify(state));
  const ownerInspection = await adapter.ownerHandles.owner.inspectOwnedState({
    state: roundTrippedState,
    signal: new AbortController().signal,
  });
  const backup = createWorkshopBackupApi({
    owner: adapter.ownerHandles.owner,
    ledger: adapter.ownerHandles.ledger,
    schemaVersion: 11,
  });
  const document = await backup.exportBackup(installationId);
  const fullInspection = await backup.inspectBackup(
    JSON.parse(JSON.stringify(document)),
  );
  return {
    ownerInspection,
    fullInspection,
    taskIdentities: state.tables.workshop_tasks.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
    })),
  };
}
export async function closeFixtureDatabase() {
  await db.close();
}
export async function createWorkshopExecutable(config, protectedReader) {
  return adapter.createWorkshopExecutable(config, protectedReader);
}
export async function createWorkshopBootstrapDependencies(
  config, protectedReader,
) {
  return adapter.createWorkshopBootstrapDependencies(config, protectedReader);
}
export async function createWorkshopSemanticConfigurationDependencies(
  config, protectedReader,
) {
  return adapter.createWorkshopSemanticConfigurationDependencies(
    config, protectedReader,
  );
}
`,
  );
  const credentialPath = join(fixture, 'credential.txt');
  writeFileSync(credentialPath, token);
  const assetBytes = Buffer.from(
    '<!doctype html><title>Packed Waystone</title>',
  );
  mkdirSync(join(fixture, 'assets'));
  writeFileSync(join(fixture, 'assets', 'index.html'), assetBytes);
  const unsignedAssetManifest = {
    format: 'waystone-assets-v1',
    files: [
      {
        path: 'index.html',
        sha256: createHash('sha256').update(assetBytes).digest('hex'),
        bytes: assetBytes.byteLength,
        mediaType: 'text/html; charset=utf-8',
        immutable: true,
      },
    ],
    entrypoint: 'index.html',
  };
  writeFileSync(
    join(fixture, 'asset-manifest.json'),
    JSON.stringify({
      ...unsignedAssetManifest,
      manifestSha256: createHash('sha256')
        .update(canonicalize(unsignedAssetManifest))
        .digest('hex'),
    }),
  );
  await writeFile(
    join(fixture, 'config.json'),
    JSON.stringify({
      format: 'gnolith-workshop-config-v1',
      listener: { host: '127.0.0.1', port, profile: 'test' },
      authentication: {
        profile: 'local-bearer-v1',
        credentialStore: { kind: 'file', value: '/unused' },
      },
      adapterModule: './adapter.mjs',
      assetMount: {
        prefix: '/app',
        manifest: { kind: 'file', value: './asset-manifest.json' },
        root: { kind: 'file', value: './assets' },
      },
    }),
  );
  const bootstrap = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
        'bootstrap-v1',
        '--config',
        join(fixture, 'config.json'),
        '--installation-id',
        'installation:packed',
        '--base-iri',
        'https://packed.invalid/',
        '--principal',
        'principal:packed',
        '--workspace',
        'workspace:packed',
        '--credential-file',
        credentialPath,
        '--idempotency-key',
        'packed-owner-v1',
      ],
      { cwd: fixture, encoding: 'utf8' },
    ),
  );
  assert.equal(bootstrap.installationId, 'installation:packed');
  const semanticInputPath = join(fixture, 'semantic-config.json');
  await writeFile(
    semanticInputPath,
    JSON.stringify({
      version: 1,
      expectedRevision: 0,
      idempotencyKey: 'packed-semantic-v1',
      configuration: {
        version: 1,
        id: 'packed-openai-sqlite-v1',
        name: 'Packed OpenAI SQLite',
        provider: {
          kind: 'openai-compatible',
          endpoint: `${semanticMockOrigin}/v1/embeddings`,
          model: 'text-embedding-packed',
          dimensions: 4,
          metric: 'cosine',
          credentialSelector: 'provider:packed',
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        },
        vector: { kind: 'sqlite' },
      },
    }),
  );
  const semanticReceipt = JSON.parse(
    (
      await execFileAsync(
        process.execPath,
        [
          join(
            fixture,
            'node_modules',
            '@gnolith',
            'workshop',
            'dist',
            'cli.js',
          ),
          'configure-semantics-v1',
          '--config',
          join(fixture, 'config.json'),
          '--input',
          semanticInputPath,
        ],
        { cwd: fixture, encoding: 'utf8' },
      )
    ).stdout,
  );
  assert.equal(semanticReceipt.configurationId, 'packed-openai-sqlite-v1');
  assert.equal(semanticReceipt.revision, 1);
  assert.equal(
    semanticReceipt.state,
    'building',
    JSON.stringify(semanticReceipt),
  );
  assert.match(semanticReceipt.fingerprint, /^[a-f0-9]{64}$/u);
  child = spawn(
    process.execPath,
    [
      join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
      'serve',
      '--config',
      join(fixture, 'config.json'),
    ],
    { cwd: fixture, stdio: 'ignore' },
  );
  const origin = `http://127.0.0.1:${port}`;
  await waitForLive(origin, child);
  const delegatedTokenBytes = Uint8Array.from(
    { length: 32 },
    (_, index) => 255 - index,
  );
  const delegatedToken = Buffer.from(delegatedTokenBytes).toString('base64url');
  const delegatedDigest = createHash('sha256')
    .update(Buffer.from('gnolith-local-bearer-v1\0', 'utf8'))
    .update(delegatedTokenBytes)
    .digest('hex');
  const initialStatus = await successfulToolCall(
    origin,
    token,
    100,
    'gnolith_status',
    {},
  );
  assert.deepEqual(initialStatus.semanticState.diagnostic, {
    format: 'gnolith-workshop-semantic-diagnostic-v1',
    version: 1,
    code: 'materialization-pending',
    retryable: true,
    backend: 'sqlite',
    repair: 'retry',
  });
  let policyRevision = initialStatus.authorizationRevision;
  const authorizationMutation = async (id, argumentsValue) => {
    const result = await successfulToolCall(
      origin,
      token,
      id,
      'authorization_admin',
      {
        version: 1,
        expectedPolicyRevision: policyRevision,
        ...argumentsValue,
      },
    );
    policyRevision = result.policyRevision;
    return result;
  };
  await authorizationMutation(101, {
    action: 'principal-create',
    idempotencyKey: 'packed-delegated-principal-v1',
    principal: { principalId: 'principal:delegated', enabled: true },
  });
  await authorizationMutation(102, {
    action: 'workspace-membership-add',
    idempotencyKey: 'packed-delegated-membership-v1',
    principalId: 'principal:delegated',
    workspaceId: 'workspace:packed',
  });
  for (const [index, capability] of [
    'read',
    'admin',
    'search:admin',
  ].entries()) {
    await authorizationMutation(103 + index, {
      action: 'workspace-grant-add',
      idempotencyKey: `packed-delegated-grant-${capability}-v1`,
      principalId: 'principal:delegated',
      workspaceId: 'workspace:packed',
      capability,
    });
  }
  const registered = await authorizationMutation(105, {
    action: 'credential-register',
    idempotencyKey: 'packed-delegated-credential-v1',
    credential: {
      credentialId: 'credential:delegated',
      tokenDigest: delegatedDigest,
      principalId: 'principal:delegated',
      workspaceId: 'workspace:packed',
    },
  });
  assert.doesNotMatch(
    JSON.stringify(registered),
    new RegExp(delegatedToken, 'u'),
  );
  assert.doesNotMatch(
    JSON.stringify(registered),
    new RegExp(delegatedDigest, 'u'),
  );
  const delegatedStatus = await successfulToolCall(
    origin,
    delegatedToken,
    106,
    'gnolith_status',
    {},
  );
  assert.equal(delegatedStatus.principalId, 'principal:delegated');
  await successfulToolCall(origin, delegatedToken, 107, 'authorization_admin', {
    version: 1,
    action: 'status',
  });
  const delegatedGrant = await successfulToolCall(
    origin,
    delegatedToken,
    108,
    'authorization_admin',
    {
      version: 1,
      action: 'workspace-grant-add',
      expectedPolicyRevision: policyRevision,
      idempotencyKey: 'packed-delegated-self-policy-v1',
      principalId: 'principal:delegated',
      workspaceId: 'workspace:packed',
      capability: 'knowledge:policy',
    },
  );
  policyRevision = delegatedGrant.policyRevision;
  await authorizationMutation(109, {
    action: 'credential-revoke',
    idempotencyKey: 'packed-delegated-credential-revoke-v1',
    credentialId: 'credential:delegated',
  });
  assert.equal(
    await mcpHttpStatus(origin, delegatedToken, 110, 'gnolith_status', {}),
    401,
  );
  await authorizationMutation(111, {
    action: 'credential-register',
    idempotencyKey: 'packed-delegated-credential-reregister-v1',
    credential: {
      credentialId: 'credential:delegated',
      tokenDigest: delegatedDigest,
      principalId: 'principal:delegated',
      workspaceId: 'workspace:packed',
    },
  });
  await successfulToolCall(origin, delegatedToken, 112, 'gnolith_status', {});
  await authorizationMutation(113, {
    action: 'principal-disable',
    idempotencyKey: 'packed-delegated-principal-disable-v1',
    principalId: 'principal:delegated',
  });
  assert.equal(
    await mcpHttpStatus(origin, delegatedToken, 114, 'gnolith_status', {}),
    401,
  );
  await successfulToolCall(origin, token, 115, 'authorization_admin', {
    version: 1,
    action: 'status',
  });
  const created = await mcp(origin, token, 4, 'tools/call', {
    name: 'create_item',
    arguments: {
      idempotencyKey: 'packed-restart-item-v1',
      authoredText: 'Create an item immediately before a clean restart.',
      data: {
        id: 'Q900',
        labels: {
          en: { language: 'en', value: 'Packed restart item' },
        },
      },
    },
  });
  assert.equal(created.result?.isError, false, JSON.stringify(created));
  const revisionTwo = await successfulToolCall(
    origin,
    token,
    116,
    'mutate_entity',
    {
      entityId: 'Q900',
      expectedRevision: 1,
      idempotencyKey: 'packed-changed-label-2',
      mutations: [
        {
          kind: 'label',
          authoredText: 'Set packed label revision two.',
          value: {
            type: 'set-label',
            language: 'en',
            value: 'Packed restart item revision two',
          },
        },
      ],
    },
  );
  assert.equal(revisionTwo.changed, true);
  assert.equal(revisionTwo.newRevision, 2);
  const beforeIdenticalStatus = await successfulToolCall(
    origin,
    token,
    117,
    'gnolith_status',
    {},
  );
  const beforeIdenticalHealth = await successfulToolCall(
    origin,
    token,
    118,
    'search_admin',
    { action: 'health' },
  );
  const identicalCalls = await Promise.all(
    ['a', 'b'].map((suffix, index) =>
      successfulToolCall(origin, token, 119 + index, 'mutate_entity', {
        entityId: 'Q900',
        expectedRevision: 2,
        idempotencyKey: `packed-identical-label-${suffix}`,
        mutations: [
          {
            kind: 'label',
            authoredText: 'Preserve the packed restart item label.',
            value: {
              type: 'set-label',
              language: 'en',
              value: 'Packed restart item revision two',
            },
          },
        ],
      }),
    ),
  );
  for (const identical of identicalCalls) {
    assert.equal(identical.changed, false);
    assert.equal(identical.newRevision, 2);
    assert.deepEqual(identical.quadPatch, { deleted: 0, inserted: 0 });
  }
  const afterIdenticalStatus = await successfulToolCall(
    origin,
    token,
    121,
    'gnolith_status',
    {},
  );
  const afterIdenticalHealth = await successfulToolCall(
    origin,
    token,
    122,
    'search_admin',
    { action: 'health' },
  );
  assert.equal(
    afterIdenticalStatus.authorizationRevision,
    beforeIdenticalStatus.authorizationRevision,
  );
  assert.equal(
    afterIdenticalHealth.materialization.sourceHighWatermark,
    beforeIdenticalHealth.materialization.sourceHighWatermark,
  );
  assert.equal(
    afterIdenticalHealth.materialization.activeAppliedWatermark,
    beforeIdenticalHealth.materialization.activeAppliedWatermark,
  );
  assert.equal(
    afterIdenticalHealth.materialization.activeCorpusGeneration,
    beforeIdenticalHealth.materialization.activeCorpusGeneration,
  );
  assert.equal(
    afterIdenticalHealth.materialization.cursorGeneration,
    beforeIdenticalHealth.materialization.cursorGeneration,
  );
  const revisionThree = await successfulToolCall(
    origin,
    token,
    123,
    'mutate_entity',
    {
      entityId: 'Q900',
      expectedRevision: 2,
      idempotencyKey: 'packed-changed-label-3',
      mutations: [
        {
          kind: 'label',
          authoredText: 'Set packed label revision three.',
          value: {
            type: 'set-label',
            language: 'en',
            value: 'Packed restart item revision three',
          },
        },
      ],
    },
  );
  assert.equal(revisionThree.changed, true);
  assert.equal(revisionThree.newRevision, 3);
  policyRevision = (
    await successfulToolCall(origin, token, 124, 'gnolith_status', {})
  ).authorizationRevision;
  const beforeVisibilityAdministration = await successfulToolCall(
    origin,
    token,
    125,
    'authorization_admin',
    { version: 1, action: 'status' },
  );
  const visibilityArguments = {
    version: 1,
    action: 'visibility-policy-set',
    expectedPolicyRevision: policyRevision,
    idempotencyKey: 'packed-q1-visibility-v1',
    target: { kind: 'entity', id: 'Q900' },
    expectedTargetRevision: 3,
    visibility: {
      version: 1,
      clauses: [[{ kind: 'workspace', workspaceId: 'workspace:packed' }]],
    },
  };
  const visibility = await successfulToolCall(
    origin,
    token,
    126,
    'authorization_admin',
    visibilityArguments,
  );
  policyRevision = visibility.policyRevision;
  const visibilityReplay = await successfulToolCall(
    origin,
    token,
    127,
    'authorization_admin',
    visibilityArguments,
  );
  assert.equal(visibilityReplay.status, 'replayed');
  assert.equal(visibilityReplay.auditId, visibility.auditId);
  const afterVisibilityAdministration = await successfulToolCall(
    origin,
    token,
    128,
    'authorization_admin',
    { version: 1, action: 'status' },
  );
  assert.equal(
    afterVisibilityAdministration.value.audits,
    beforeVisibilityAdministration.value.audits + 1,
  );
  const effectiveVisibility = await successfulToolCall(
    origin,
    token,
    129,
    'authorization_admin',
    {
      version: 1,
      action: 'effective-policy',
      target: { kind: 'entity', id: 'Q900' },
    },
  );
  assert.equal(effectiveVisibility.value.sourceRevision, 4);
  assert.equal(
    effectiveVisibility.value.sourcePolicyRevision,
    visibility.policyRevision,
  );
  assert.deepEqual(
    effectiveVisibility.value.visibility,
    visibilityArguments.visibility,
  );
  const visibilityConflict = await mcp(origin, token, 130, 'tools/call', {
    name: 'authorization_admin',
    arguments: {
      ...visibilityArguments,
      visibility: { version: 1, clauses: [] },
    },
  });
  assert.ok(
    visibilityConflict.error || visibilityConflict.result?.isError === true,
    JSON.stringify(visibilityConflict),
  );
  const outsiderBytes = Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index + 120),
  );
  const outsiderToken = outsiderBytes.toString('base64url');
  const outsiderDigest = createHash('sha256')
    .update(Buffer.from('gnolith-local-bearer-v1\0', 'utf8'))
    .update(outsiderBytes)
    .digest('hex');
  for (const [index, argumentsValue] of [
    {
      action: 'principal-create',
      idempotencyKey: 'packed-outsider-principal-v1',
      principal: { principalId: 'principal:outsider', enabled: true },
    },
    {
      action: 'workspace-membership-add',
      idempotencyKey: 'packed-outsider-membership-v1',
      principalId: 'principal:outsider',
      workspaceId: 'workspace:outsider',
    },
    {
      action: 'workspace-grant-add',
      idempotencyKey: 'packed-outsider-read-v1',
      principalId: 'principal:outsider',
      workspaceId: 'workspace:outsider',
      capability: 'read',
    },
    {
      action: 'credential-register',
      idempotencyKey: 'packed-outsider-credential-v1',
      credential: {
        credentialId: 'credential:outsider',
        tokenDigest: outsiderDigest,
        principalId: 'principal:outsider',
        workspaceId: 'workspace:outsider',
      },
    },
  ].entries()) {
    const administered = await successfulToolCall(
      origin,
      token,
      131 + index,
      'authorization_admin',
      {
        version: 1,
        expectedPolicyRevision: policyRevision,
        ...argumentsValue,
      },
    );
    policyRevision = administered.policyRevision;
  }
  const orVisibilityEntity = await successfulToolCall(
    origin,
    token,
    150,
    'create_item',
    {
      idempotencyKey: 'packed-owner-reader-or-item-v1',
      authoredText:
        'Create the owner and reader OR visibility restart fixture.',
      data: {
        id: 'Q2',
        labels: {
          en: {
            language: 'en',
            value: 'Orchard heliotrope visibility proof',
          },
        },
      },
    },
  );
  assert.equal(orVisibilityEntity.newRevision, 1);
  policyRevision = (
    await successfulToolCall(origin, token, 151, 'gnolith_status', {})
  ).authorizationRevision;
  const beforeRejectedOr = await successfulToolCall(
    origin,
    token,
    152,
    'authorization_admin',
    { version: 1, action: 'status' },
  );
  const rejectedAndVisibility = await mcp(origin, token, 153, 'tools/call', {
    name: 'authorization_admin',
    arguments: {
      version: 1,
      action: 'visibility-policy-set',
      expectedPolicyRevision: policyRevision,
      idempotencyKey: 'packed-owner-reader-and-rejected-v1',
      target: { kind: 'entity', id: 'Q2' },
      expectedTargetRevision: 1,
      visibility: {
        version: 1,
        clauses: [
          [{ kind: 'principal', principalId: 'principal:packed' }],
          [{ kind: 'principal', principalId: 'principal:outsider' }],
        ],
      },
    },
  });
  assert.equal(
    toolErrorCode(rejectedAndVisibility),
    'validation_failed',
    JSON.stringify(rejectedAndVisibility),
  );
  assert.match(JSON.stringify(rejectedAndVisibility), /unsatisfiable/u);
  const afterRejectedOr = await successfulToolCall(
    origin,
    token,
    154,
    'authorization_admin',
    { version: 1, action: 'status' },
  );
  assert.equal(
    afterRejectedOr.value.audits,
    beforeRejectedOr.value.audits,
    JSON.stringify(afterRejectedOr),
  );
  const acceptedOrVisibility = await successfulToolCall(
    origin,
    token,
    155,
    'authorization_admin',
    {
      version: 1,
      action: 'visibility-policy-set',
      expectedPolicyRevision: policyRevision,
      idempotencyKey: 'packed-owner-reader-or-v1',
      target: { kind: 'entity', id: 'Q2' },
      expectedTargetRevision: 1,
      visibility: {
        version: 1,
        clauses: [
          [
            { kind: 'principal', principalId: 'principal:packed' },
            { kind: 'principal', principalId: 'principal:outsider' },
          ],
        ],
      },
    },
  );
  policyRevision = acceptedOrVisibility.policyRevision;
  const acceptedOrStatus = await successfulToolCall(
    origin,
    token,
    156,
    'authorization_admin',
    { version: 1, action: 'status' },
  );
  assert.equal(
    acceptedOrStatus.value.audits,
    beforeRejectedOr.value.audits + 1,
  );
  const acceptedOrPolicy = await successfulToolCall(
    origin,
    token,
    157,
    'authorization_admin',
    {
      version: 1,
      action: 'effective-policy',
      target: { kind: 'entity', id: 'Q2' },
    },
  );
  assert.equal(acceptedOrPolicy.value.sourceRevision, 2);
  assert.deepEqual(acceptedOrPolicy.value.visibility.clauses, [
    [
      { kind: 'principal', principalId: 'principal:outsider' },
      { kind: 'principal', principalId: 'principal:packed' },
    ],
  ]);
  const outsiderOrRead = await successfulToolCall(
    origin,
    outsiderToken,
    158,
    'get_entity',
    { entityId: 'Q2' },
  );
  assert.match(JSON.stringify(outsiderOrRead), /"id":"Q2"/u);
  const outsiderRead = await mcp(origin, outsiderToken, 135, 'tools/call', {
    name: 'get_entity',
    arguments: { entityId: 'Q900' },
  });
  assert.ok(
    outsiderRead.error || outsiderRead.result?.isError === true,
    JSON.stringify(outsiderRead),
  );
  const laggedHealth = await mcp(origin, token, 5, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  assert.equal(
    laggedHealth.result?.isError,
    false,
    JSON.stringify(laggedHealth),
  );
  const lagged = laggedHealth.result.structuredContent.materialization;
  assert.ok(
    lagged.sourceHighWatermark > lagged.activeAppliedWatermark,
    JSON.stringify(lagged),
  );
  const materialized = await mcp(origin, token, 11, 'tools/call', {
    name: 'search_admin',
    arguments: {
      action: 'materialize',
      limit: 100,
      options: { maxRebuildRoots: 100 },
    },
  });
  assert.equal(
    materialized.result?.isError,
    false,
    JSON.stringify(materialized),
  );
  assert.ok(
    materialized.result.structuredContent.completed >= 1,
    JSON.stringify(materialized),
  );
  const materializedReplay = await mcp(origin, token, 12, 'tools/call', {
    name: 'search_admin',
    arguments: {
      action: 'materialize',
      limit: 100,
      options: { maxRebuildRoots: 100 },
    },
  });
  assert.equal(
    materializedReplay.result?.isError,
    false,
    JSON.stringify(materializedReplay),
  );
  assert.equal(materializedReplay.result.structuredContent.completed, 0);
  const caughtUpHealth = await mcp(origin, token, 13, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  assert.equal(
    caughtUpHealth.result.structuredContent.materialization
      .activeAppliedWatermark,
    caughtUpHealth.result.structuredContent.materialization.sourceHighWatermark,
  );
  const semanticEstimate = await successfulToolCall(
    origin,
    token,
    214,
    'search_admin',
    {
      action: 'semantic-estimate',
      options: {
        configurationId: 'packed-openai-sqlite-v1',
        policy: { mode: 'asap', maxBatchesPerRun: 1 },
      },
    },
  );
  await successfulToolCall(origin, token, 215, 'search_admin', {
    action: 'semantic-approve',
    options: { planId: semanticEstimate.planId },
  });
  const secondCreated = await mcp(origin, token, 14, 'tools/call', {
    name: 'create_item',
    arguments: {
      idempotencyKey: 'packed-restart-item-v2',
      authoredText: 'Create a second item to prove restart catch-up.',
      data: {
        id: 'Q901',
        labels: {
          en: { language: 'en', value: 'Packed restart item two' },
        },
      },
    },
  });
  assert.equal(
    secondCreated.result?.isError,
    false,
    JSON.stringify(secondCreated),
  );
  const secondLaggedHealth = await mcp(origin, token, 15, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  const secondLagged =
    secondLaggedHealth.result.structuredContent.materialization;
  assert.ok(
    secondLagged.sourceHighWatermark > secondLagged.activeAppliedWatermark,
    JSON.stringify(secondLagged),
  );
  const laggedStatus = await mcp(origin, token, 10, 'tools/call', {
    name: 'gnolith_status',
    arguments: {},
  });
  assert.equal(
    laggedStatus.result?.isError,
    false,
    JSON.stringify(laggedStatus),
  );
  assert.equal(laggedStatus.result.structuredContent.lexicalReady, false);
  const corpusGeneration = secondLagged.activeCorpusGeneration;
  await terminate(child);
  child = spawn(
    process.execPath,
    [
      join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
      'serve',
      '--config',
      join(fixture, 'config.json'),
    ],
    { cwd: fixture, stdio: 'ignore' },
  );
  await waitForLive(origin, child);
  const initiallyUnready = await fetch(`${origin}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(initiallyUnready.status, 503);
  assert.equal((await initiallyUnready.json()).lexicalReady, false);
  const restartHealth = await mcp(origin, token, 6, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  assert.equal(
    restartHealth.result.structuredContent.materialization
      .activeCorpusGeneration,
    corpusGeneration,
  );
  assert.ok(
    restartHealth.result.structuredContent.materialization.sourceHighWatermark >
      restartHealth.result.structuredContent.materialization
        .activeAppliedWatermark,
  );
  const recovered = await waitForReady(origin, token, child);
  assert.equal(recovered.lexicalReady, true);
  assert.equal(recovered.semanticState.ready, true);
  assert.equal(recovered.semanticState.diagnostic, null);
  const outsiderOrReadAfterRestart = await successfulToolCall(
    origin,
    outsiderToken,
    159,
    'get_entity',
    { entityId: 'Q2' },
  );
  assert.match(JSON.stringify(outsiderOrReadAfterRestart), /"id":"Q2"/u);
  const outsiderOrSearchAfterRestart = await successfulToolCall(
    origin,
    outsiderToken,
    160,
    'search',
    {
      text: 'orchard heliotrope',
      kinds: ['item'],
      limit: 20,
    },
  );
  assert.ok(
    outsiderOrSearchAfterRestart.items.some((entry) => entry.sourceId === 'Q2'),
    JSON.stringify(outsiderOrSearchAfterRestart),
  );
  const semanticOnly = await successfulToolCall(origin, token, 216, 'search', {
    text: 'meaning that has no lexical token overlap',
    kinds: ['item'],
    limit: 20,
  });
  assert.ok(
    semanticOnly.items.some((entry) => entry.sourceId === 'Q900'),
    JSON.stringify(semanticOnly),
  );
  const recoveredHealth = await mcp(origin, token, 7, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  assert.equal(
    recoveredHealth.result.structuredContent.materialization
      .activeCorpusGeneration,
    corpusGeneration,
  );
  assert.equal(
    recoveredHealth.result.structuredContent.materialization
      .activeAppliedWatermark,
    recoveredHealth.result.structuredContent.materialization
      .sourceHighWatermark,
  );
  assert.deepEqual(await (await fetch(`${origin}/health/live`)).json(), {
    status: 'live',
  });
  const app = await fetch(`${origin}/app`);
  assert.equal(app.status, 200);
  const appBytes = Buffer.from(await app.arrayBuffer());
  assert.match(appBytes.toString('utf8'), /Packed Waystone/u);
  const slashApp = await fetch(`${origin}/app/`);
  assert.equal(slashApp.status, 200);
  assert.equal(
    slashApp.headers.get('content-type'),
    app.headers.get('content-type'),
  );
  assert.deepEqual(Buffer.from(await slashApp.arrayBuffer()), appBytes);
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/app/%2e%2e/secret`)).status, 404);
  for (const target of [
    '/app/%2e%2e/mcp',
    '/app/%2E%2E/health/live',
    '/app%2f..%2fmcp',
  ]) {
    const response = await rawHttp(port, target);
    assert.match(response.statusLine, / 400 /u, target);
    assert.match(response.body, /bad_request/u, target);
  }
  const initialize = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    }),
  });
  const body = await initialize.json();
  assert.equal(body.result.serverInfo.name, 'gnolith');
  assert.equal(body.result.serverInfo.version, '0.5.0');
  const restartedTools = await mcp(origin, token, 8, 'tools/list', {});
  assert.equal(restartedTools.result.tools.length, 52);
  const status = await mcp(origin, token, 3, 'tools/call', {
    name: 'gnolith_status',
    arguments: {},
  });
  assert.equal(status.result?.isError, false, JSON.stringify(status));
  assert.equal(status.result.structuredContent.blobReady, true);
  assert.equal(status.result.structuredContent.semanticState.configured, true);
  assert.equal(status.result.structuredContent.semanticState.revision, 1);
  assert.match(
    status.result.structuredContent.semanticState.fingerprint,
    /^[a-f0-9]{64}$/u,
  );
  const item = await mcp(origin, token, 9, 'tools/call', {
    name: 'get_entity',
    arguments: { entityId: 'Q900' },
  });
  assert.equal(item.result?.isError, false, JSON.stringify(item));
  assert.match(JSON.stringify(item.result.structuredContent), /"id":"Q900"/u);
  assert.match(
    JSON.stringify(item.result.structuredContent),
    /Packed restart item/u,
  );
  const populated = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(root, 'scripts', 'populate-public-backup-fixture.mjs'),
        origin,
        token,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  assert.equal(populated.format, 'gnolith-workshop-public-backup-fixture-v1');
  assert.equal(populated.q1Visibility.target.id, 'Q1');
  const q1PolicyRevision = (
    await successfulToolCall(origin, token, 180, 'gnolith_status', {})
  ).authorizationRevision;
  const q1FailureArguments = {
    version: 1,
    action: 'visibility-policy-set',
    expectedPolicyRevision: q1PolicyRevision,
    expectedTargetRevision: 3,
    visibility: {
      version: 1,
      clauses: [[{ kind: 'workspace', workspaceId: 'workspace:packed' }]],
    },
  };
  for (const [id, expectedCode, argumentsValue] of [
    [
      181,
      'conflict',
      {
        ...q1FailureArguments,
        idempotencyKey: 'packed-q1-stale-v1',
        target: { kind: 'entity', id: 'Q1' },
      },
    ],
    [
      182,
      'not_found',
      {
        ...q1FailureArguments,
        idempotencyKey: 'packed-q1-missing-v1',
        target: { kind: 'entity', id: 'Q999' },
      },
    ],
    [
      183,
      'validation_failed',
      {
        ...q1FailureArguments,
        idempotencyKey: 'packed-q1-invalid-v1',
        target: { kind: 'entity', id: 'Q0' },
      },
    ],
  ]) {
    const failed = await mcp(origin, token, id, 'tools/call', {
      name: 'authorization_admin',
      arguments: argumentsValue,
    });
    assert.equal(toolErrorCode(failed), expectedCode, JSON.stringify(failed));
  }
  const unauthorizedQ1 = await mcp(origin, outsiderToken, 184, 'tools/call', {
    name: 'authorization_admin',
    arguments: {
      ...q1FailureArguments,
      idempotencyKey: 'packed-q1-unauthorized-v1',
      target: { kind: 'entity', id: 'Q1' },
    },
  });
  assert.equal(
    toolErrorCode(unauthorizedQ1),
    'forbidden',
    JSON.stringify(unauthorizedQ1),
  );
  const allKindMaterialization = await successfulToolCall(
    origin,
    token,
    190,
    'search_admin',
    {
      action: 'materialize',
      limit: 1_000,
      options: { maxRebuildRoots: 1_000 },
    },
  );
  assert.ok(allKindMaterialization.claimed >= 7);
  assert.equal(
    allKindMaterialization.health.activeAppliedWatermark,
    allKindMaterialization.health.sourceHighWatermark,
  );
  const publicSearchFixtures = [
    ['item', 'Backup fixture subject', 'Q1'],
    [
      'resource',
      'Inline backup fixture resource payload',
      'resource:backup-fixture',
    ],
    [
      'annotation',
      'Backup fixture annotation body',
      'annotation:backup-fixture',
    ],
    ['task', 'Complete the backup fixture task', populated.taskId],
    ['memory', 'deterministic memory revision', 'backup-fixture-memory'],
    ['prompt', 'deterministic prompt revision', populated.promptId],
  ];
  for (const [
    index,
    [kind, text, sourceId],
  ] of publicSearchFixtures.entries()) {
    const page = await successfulToolCall(
      origin,
      token,
      191 + index,
      'search',
      { text, kinds: [kind], limit: 20 },
    );
    assert.ok(
      page.items.some(
        (entry) => entry.kind === kind && entry.sourceId === sourceId,
      ),
      JSON.stringify({ kind, text, sourceId, page }),
    );
  }
  const statementSearches = [];
  for (const [index, text] of [
    'Add',
    'fixture',
    'statement',
    'qualified',
  ].entries()) {
    statementSearches.push(
      await successfulToolCall(origin, token, 210 + index, 'search', {
        text,
        kinds: ['statement'],
        limit: 20,
      }),
    );
  }
  assert.ok(
    statementSearches.some((page) =>
      page.items.some(
        (entry) =>
          entry.kind === 'statement' &&
          entry.sourceId === 'Q1$backup-fixture-statement',
      ),
    ),
    JSON.stringify(statementSearches),
  );
  const transientResourceText = 'Transient mixed lifecycle resource payload.';
  const transientResourceBytes = Buffer.from(transientResourceText, 'utf8');
  const transientResource = await successfulToolCall(
    origin,
    token,
    2300,
    'create_resource',
    {
      idempotencyKey: 'packed-mixed-resource-v1',
      data: {
        id: 'resource:packed-mixed-lifecycle',
        itemId: 'Q1',
        title: 'Packed mixed lifecycle resource',
        payload: { kind: 'inline-text', text: transientResourceText },
        mediaType: 'text/plain',
        language: 'en',
        integrity: {
          algorithm: 'sha256',
          digest: createHash('sha256')
            .update(transientResourceBytes)
            .digest('hex'),
          byteLength: transientResourceBytes.byteLength,
        },
      },
    },
  );
  const transientResourceUpdated = await successfulToolCall(
    origin,
    token,
    2301,
    'update_resource',
    {
      resourceId: transientResource.id,
      expectedRevision: transientResource.revision,
      idempotencyKey: 'packed-mixed-resource-v2',
      patch: { title: 'Packed mixed lifecycle resource revised' },
    },
  );
  const transientAnnotation = await successfulToolCall(
    origin,
    token,
    2302,
    'create_annotation',
    {
      idempotencyKey: 'packed-mixed-annotation-v1',
      data: {
        id: 'annotation:packed-mixed-lifecycle',
        body: {
          kind: 'text',
          text: 'Packed mixed lifecycle annotation.',
          mediaType: 'text/plain',
          language: 'en',
        },
        target: {
          kind: 'resource',
          sourceId: transientResource.id,
          selector: { type: 'FragmentSelector', value: 'line=1' },
        },
        motivation: 'commenting',
      },
    },
  );
  const transientAnnotationUpdated = await successfulToolCall(
    origin,
    token,
    2303,
    'update_annotation',
    {
      annotationId: transientAnnotation.id,
      expectedRevision: transientAnnotation.revision,
      idempotencyKey: 'packed-mixed-annotation-v2',
      patch: {
        body: {
          kind: 'text',
          text: 'Packed mixed lifecycle annotation revised.',
          mediaType: 'text/plain',
          language: 'en',
        },
      },
    },
  );
  const transientMemoryInput = {
    slug: 'packed-mixed-lifecycle-memory',
    idempotencyKey: 'packed-mixed-memory-v1',
    description: 'Packed mixed lifecycle memory',
    content: 'Packed mixed lifecycle memory revision one.',
  };
  const transientMemory = await successfulToolCall(
    origin,
    token,
    2304,
    'upsert_memory',
    transientMemoryInput,
  );
  const beforeMemoryReplay = await successfulToolCall(
    origin,
    token,
    2305,
    'search_admin',
    { action: 'health' },
  );
  assert.deepEqual(
    await successfulToolCall(
      origin,
      token,
      2306,
      'upsert_memory',
      transientMemoryInput,
    ),
    transientMemory,
  );
  const afterMemoryReplay = await successfulToolCall(
    origin,
    token,
    2307,
    'search_admin',
    { action: 'health' },
  );
  assert.equal(
    afterMemoryReplay.materialization.sourceHighWatermark,
    beforeMemoryReplay.materialization.sourceHighWatermark,
  );
  const transientMemoryUpdated = await successfulToolCall(
    origin,
    token,
    2308,
    'upsert_memory',
    {
      slug: transientMemory.slug,
      expectedRevision: transientMemory.revision,
      idempotencyKey: 'packed-mixed-memory-v2',
      description: transientMemory.description,
      content: 'Packed mixed lifecycle memory revision two.',
    },
  );
  const transientPrompt = await successfulToolCall(
    origin,
    token,
    2309,
    'create_prompt',
    {
      idempotencyKey: 'packed-mixed-prompt-v1',
      name: 'packed-mixed-lifecycle-prompt',
      promptText: 'Packed mixed lifecycle prompt revision one.',
    },
  );
  const transientPromptUpdated = await successfulToolCall(
    origin,
    token,
    2310,
    'update_prompt',
    {
      promptId: transientPrompt.id,
      expectedRevision: transientPrompt.revision,
      idempotencyKey: 'packed-mixed-prompt-v2',
      patch: { promptText: 'Packed mixed lifecycle prompt revision two.' },
    },
  );
  const transientTask = await successfulToolCall(
    origin,
    token,
    2311,
    'create_task',
    {
      idempotencyKey: 'packed-mixed-task-v1',
      description: 'Archive the packed mixed lifecycle task',
      prompt: 'Archive after the lifecycle projection is committed.',
    },
  );
  await successfulToolCall(origin, token, 2312, 'archive_task', {
    taskId: transientTask.id,
    expectedRevision: transientTask.revision,
  });
  await successfulToolCall(origin, token, 2313, 'delete_annotation', {
    annotationId: transientAnnotation.id,
    expectedRevision: transientAnnotationUpdated.revision,
    idempotencyKey: 'packed-mixed-annotation-delete-v3',
  });
  await successfulToolCall(origin, token, 2314, 'delete_resource', {
    resourceId: transientResource.id,
    expectedRevision: transientResourceUpdated.revision,
    idempotencyKey: 'packed-mixed-resource-delete-v3',
  });
  await successfulToolCall(origin, token, 2315, 'delete_memory', {
    slug: transientMemory.slug,
    expectedRevision: transientMemoryUpdated.revision,
    idempotencyKey: 'packed-mixed-memory-delete-v3',
  });
  await successfulToolCall(origin, token, 2316, 'delete_prompt', {
    promptId: transientPrompt.id,
    expectedRevision: transientPromptUpdated.revision,
    idempotencyKey: 'packed-mixed-prompt-delete-v3',
  });
  const mixedLagged = await successfulToolCall(
    origin,
    token,
    2317,
    'search_admin',
    { action: 'health' },
  );
  assert.equal(mixedLagged.materialization.deadJobs, 0);
  assert.ok(
    mixedLagged.materialization.sourceHighWatermark >
      mixedLagged.materialization.activeAppliedWatermark,
    JSON.stringify(mixedLagged),
  );
  for (let page = 0; page < 10; page += 1) {
    await successfulToolCall(origin, token, 2318 + page, 'search_admin', {
      action: 'materialize',
      limit: 100,
      options: { maxRebuildRoots: 100 },
    });
  }
  const mixedCaughtUp = await successfulToolCall(
    origin,
    token,
    2328,
    'search_admin',
    { action: 'health' },
  );
  assert.deepEqual(
    {
      pendingJobs: mixedCaughtUp.materialization.pendingJobs,
      leasedJobs: mixedCaughtUp.materialization.leasedJobs,
      deadJobs: mixedCaughtUp.materialization.deadJobs,
      staleHeads: mixedCaughtUp.materialization.staleHeads,
      activeAppliedWatermark:
        mixedCaughtUp.materialization.activeAppliedWatermark,
    },
    {
      pendingJobs: 0,
      leasedJobs: 0,
      deadJobs: 0,
      staleHeads: 0,
      activeAppliedWatermark: mixedCaughtUp.materialization.sourceHighWatermark,
    },
  );
  await successfulToolCall(origin, token, 2329, 'search_admin', {
    action: 'rebuild',
  });
  const duplicateRebuild = await mcp(origin, token, 2330, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'rebuild' },
  });
  assert.equal(
    toolErrorCode(duplicateRebuild),
    'conflict',
    JSON.stringify(duplicateRebuild),
  );
  for (let page = 0; page < 10; page += 1) {
    await successfulToolCall(origin, token, 2331 + page, 'search_admin', {
      action: 'materialize',
      limit: 100,
      options: { maxRebuildRoots: 100 },
    });
  }
  await successfulToolCall(origin, token, 2341, 'search_admin', {
    action: 'activate',
  });
  const mixedActivated = await successfulToolCall(
    origin,
    token,
    2342,
    'search_admin',
    { action: 'health' },
  );
  assert.deepEqual(
    {
      status: mixedActivated.materialization.status,
      shadowCorpusGeneration:
        mixedActivated.materialization.shadowCorpusGeneration,
      pendingJobs: mixedActivated.materialization.pendingJobs,
      leasedJobs: mixedActivated.materialization.leasedJobs,
      deadJobs: mixedActivated.materialization.deadJobs,
      staleHeads: mixedActivated.materialization.staleHeads,
      activeAppliedWatermark:
        mixedActivated.materialization.activeAppliedWatermark,
    },
    {
      status: 'healthy',
      shadowCorpusGeneration: null,
      pendingJobs: 0,
      leasedJobs: 0,
      deadJobs: 0,
      staleHeads: 0,
      activeAppliedWatermark:
        mixedActivated.materialization.sourceHighWatermark,
    },
  );
  const qdrantConfiguration = await successfulToolCall(
    origin,
    token,
    220,
    'search_admin',
    {
      action: 'configure',
      options: {
        expectedRevision: 0,
        idempotencyKey: 'packed-openai-qdrant-v1',
        configuration: {
          version: 1,
          id: 'packed-openai-qdrant-v1',
          name: 'Packed OpenAI Qdrant',
          provider: {
            kind: 'openai-compatible',
            endpoint: `${semanticMockOrigin}/v1/embeddings`,
            model: 'text-embedding-packed',
            dimensions: 4,
            metric: 'cosine',
            credentialSelector: 'provider:packed',
            allowPrivateEndpoint: true,
            redirectPolicy: 'error',
          },
          vector: {
            kind: 'qdrant',
            endpoint: semanticMockOrigin,
            collection: 'packed_vectors',
            credentialSelector: 'qdrant:packed',
            allowPrivateEndpoint: true,
            redirectPolicy: 'error',
          },
        },
      },
    },
  );
  assert.equal(qdrantConfiguration.configurationId, 'packed-openai-qdrant-v1');
  const qdrantPending = await successfulToolCall(
    origin,
    token,
    2201,
    'gnolith_status',
    {},
  );
  assert.deepEqual(qdrantPending.semanticState.diagnostic, {
    format: 'gnolith-workshop-semantic-diagnostic-v1',
    version: 1,
    code: 'materialization-pending',
    retryable: true,
    backend: 'qdrant',
    repair: 'retry',
  });
  const qdrantEstimate = await successfulToolCall(
    origin,
    token,
    221,
    'search_admin',
    {
      action: 'semantic-estimate',
      options: {
        configurationId: 'packed-openai-qdrant-v1',
        policy: { mode: 'asap', maxBatchesPerRun: 2 },
      },
    },
  );
  await successfulToolCall(origin, token, 222, 'search_admin', {
    action: 'semantic-approve',
    options: { planId: qdrantEstimate.planId },
  });
  const qdrantReady = await waitForReady(origin, token, child);
  assert.equal(qdrantReady.semanticState.ready, true);
  assert.equal(qdrantReady.semanticState.diagnostic, null);
  await terminate(child);
  child = spawn(
    process.execPath,
    [
      join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
      'serve',
      '--config',
      join(fixture, 'config.json'),
    ],
    { cwd: fixture, stdio: 'ignore' },
  );
  await waitForLive(origin, child);
  const qdrantRestarted = await waitForReady(origin, token, child);
  assert.equal(qdrantRestarted.semanticState.ready, true);
  assert.ok(
    [...semanticMockPoints.values()].some(
      (point) => point.payload?.sourceId === 'Q1',
    ),
    JSON.stringify(
      [...semanticMockPoints.values()].map(
        (point) => point.payload?.sourceId ?? null,
      ),
    ),
  );
  const qdrantSemanticOnly = await successfulToolCall(
    origin,
    token,
    223,
    'search',
    {
      text: 'another phrase with no lexical overlap',
      kinds: ['item'],
      limit: 20,
    },
  );
  assert.ok(
    qdrantSemanticOnly.items.some((entry) => entry.sourceId === 'Q1'),
    JSON.stringify(qdrantSemanticOnly),
  );
  const secondBackupTask = await successfulToolCall(
    origin,
    token,
    200,
    'create_task',
    {
      idempotencyKey: 'backup-fixture-second-task-v1',
      description: 'Complete a second independent backup task',
      prompt: 'Return the second deterministic fixture outcome.',
    },
  );
  const secondBackupClaim = await successfulToolCall(
    origin,
    token,
    201,
    'claim_task',
    { taskId: secondBackupTask.id, leaseSeconds: 300 },
  );
  await successfulToolCall(origin, token, 202, 'complete_task', {
    taskId: secondBackupTask.id,
    leaseToken: secondBackupClaim.leaseToken,
    expectedRevision:
      secondBackupClaim.task?.revision ?? secondBackupClaim.revision,
    idempotencyKey: 'backup-fixture-second-task-complete-v1',
    result: 'Second backup fixture completed.',
    outcomeKind: 'success',
  });
  await successfulToolCall(origin, token, 203, 'search_admin', {
    action: 'materialize',
    limit: 100,
    options: { maxRebuildRoots: 100 },
  });
  const unavailableSemantic = await successfulToolCall(
    origin,
    token,
    224,
    'search_admin',
    {
      action: 'configure',
      options: {
        expectedRevision: 0,
        idempotencyKey: 'packed-unavailable-semantic-v1',
        configuration: {
          version: 1,
          id: 'packed-unavailable-semantic-v1',
          name: 'Packed unavailable semantic endpoint',
          provider: {
            kind: 'openai-compatible',
            endpoint: 'http://127.0.0.1:1/v1/embeddings',
            model: 'text-embedding-packed',
            dimensions: 4,
            metric: 'cosine',
            credentialSelector: 'provider:packed',
            allowPrivateEndpoint: true,
            redirectPolicy: 'error',
          },
          vector: { kind: 'sqlite' },
        },
      },
    },
  );
  assert.equal(unavailableSemantic.ready, false);
  const degraded = await fetch(`${origin}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(degraded.status, 503);
  const degradedBody = await degraded.json();
  assert.equal(degradedBody.lexicalReady, true);
  assert.deepEqual(degradedBody.semanticState.diagnostic, {
    format: 'gnolith-workshop-semantic-diagnostic-v1',
    version: 1,
    code: 'provider-unavailable',
    retryable: true,
    backend: 'sqlite',
    repair: 'retry',
  });
  assert.doesNotMatch(JSON.stringify(degradedBody), /127\.0\.0\.1|secret/u);
  await terminate(child);
  child = spawn(
    process.execPath,
    [
      join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
      'serve',
      '--config',
      join(fixture, 'config.json'),
    ],
    { cwd: fixture, stdio: 'ignore' },
  );
  await waitForLive(origin, child);
  const degradedAfterRestart = await fetch(`${origin}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(degradedAfterRestart.status, 503);
  assert.equal((await degradedAfterRestart.json()).lexicalReady, true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  assert.equal(child.exitCode, null, 'bad semantic config restart-looped');
  await terminate(child);
  const ownInspection = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(root, 'scripts', 'inspect-packed-owner.mjs'),
        join(fixture, 'adapter.mjs'),
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  assert.ok(ownInspection.ownerInspection.taskCount >= 2);
  assert.ok(ownInspection.ownerInspection.memoryCount >= 1);
  assert.ok(ownInspection.ownerInspection.promptCount >= 1);
  assert.equal(ownInspection.fullInspection.valid, true);
  assert.deepEqual(
    ownInspection.taskIdentities
      .map(({ idempotencyKey }) => idempotencyKey)
      .sort(),
    [
      'installation:packed\u0000workspace:packed\u0000principal:packed\u0000backup-fixture-second-task-v1',
      'installation:packed\u0000workspace:packed\u0000principal:packed\u0000backup-fixture-task-v1',
      'installation:packed\u0000workspace:packed\u0000principal:packed\u0000packed-mixed-task-v1',
    ],
  );
  process.stdout.write(
    `${JSON.stringify({ packedProcess: 'ok', catalogDigest: 'af455b4d6ab3560bca9c0ab48e9db7bd3cbcfa166ace875578d88d182069071f' })}\n`,
  );
} finally {
  if (child?.exitCode === null) await terminate(child);
  if (semanticMock)
    await new Promise((resolvePromise, reject) =>
      semanticMock.close((error) => (error ? reject(error) : resolvePromise())),
    );
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await rm(tarball, { force: true });
}

async function startSemanticMock() {
  const points = new Map();
  // The Node listener owns the returned promise through its response lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = await readNodeBody(request);
      if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
        assert.equal(
          request.headers.authorization,
          'Bearer packed-openai-secret',
        );
        const input = JSON.parse(body);
        assert.equal(input.dimensions, 4);
        assert.ok(Array.isArray(input.input));
        return json(response, 200, {
          data: input.input.map((_, index) => ({
            index,
            embedding: [1, 0, 0, 0],
          })),
          usage: { total_tokens: input.input.length },
        });
      }
      const collection = '/collections/packed_vectors';
      if (url.pathname.startsWith(collection)) {
        assert.equal(request.headers['api-key'], 'packed-qdrant-secret');
        if (url.pathname === collection && request.method === 'GET')
          return json(response, 200, {
            result: {
              config: {
                params: { vectors: { size: 4, distance: 'Cosine' } },
              },
            },
          });
        if (
          url.pathname === `${collection}/points` &&
          request.method === 'PUT'
        ) {
          for (const point of JSON.parse(body).points ?? [])
            points.set(point.id, point);
          return json(response, 200, { result: { status: 'completed' } });
        }
        if (
          url.pathname === `${collection}/points/delete` &&
          request.method === 'POST'
        ) {
          const deletion = JSON.parse(body);
          if (Array.isArray(deletion.points))
            for (const point of deletion.points) points.delete(point);
          else points.clear();
          return json(response, 200, { result: { status: 'completed' } });
        }
        if (
          url.pathname === `${collection}/points/query` &&
          request.method === 'POST'
        )
          return json(response, 200, {
            result: {
              points: [...points.values()]
                .sort((left, right) =>
                  left.payload?.sourceId === 'Q1'
                    ? -1
                    : right.payload?.sourceId === 'Q1'
                      ? 1
                      : String(left.id).localeCompare(String(right.id)),
                )
                .map((point) => ({
                  id: point.id,
                  score: point.payload?.sourceId === 'Q1' ? 2 : 1,
                  payload: point.payload,
                })),
            },
          });
      }
      return json(response, 404, { error: 'unexpected mock route' });
    } catch (error) {
      return json(response, 500, {
        error: error instanceof Error ? error.message : 'mock failure',
      });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    points,
  };
}

async function readNodeBody(request) {
  let value = '';
  for await (const chunk of request) value += String(chunk);
  return value;
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function mcp(origin, token, id, method, params) {
  return (
    await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    })
  ).json();
}

async function successfulToolCall(origin, token, id, name, argumentsValue) {
  const response = await mcp(origin, token, id, 'tools/call', {
    name,
    arguments: argumentsValue,
  });
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  return response.result.structuredContent;
}

function toolErrorCode(response) {
  return (
    response.error?.data?.code ??
    response.result?.structuredContent?.code ??
    (response.error?.code === -32001 ? 'forbidden' : null) ??
    null
  );
}

async function mcpHttpStatus(origin, token, id, name, argumentsValue) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }),
  });
  return response.status;
}

async function terminate(processHandle) {
  if (processHandle.exitCode !== null) return;
  const exited = new Promise((resolvePromise) =>
    processHandle.once('exit', resolvePromise),
  );
  processHandle.kill('SIGTERM');
  const completed = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) =>
      setTimeout(() => resolvePromise(false), 10_000),
    ),
  ]);
  if (completed) return;
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'taskkill',
        ['/pid', String(processHandle.pid), '/t', '/f'],
        {
          stdio: 'ignore',
        },
      );
    } catch (error) {
      if (processHandle.kill(0)) throw error;
      return;
    }
  } else if (!processHandle.kill('SIGKILL')) return;
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function rawHttp(port, target) {
  const response = await new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(port, '127.0.0.1');
    let value = '';
    socket.setEncoding('utf8');
    socket.once('error', rejectPromise);
    socket.on('data', (chunk) => {
      value += String(chunk);
    });
    socket.once('end', () => resolvePromise(value));
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

async function waitForLive(origin, processHandle) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null)
      throw new Error(`packed process exited ${processHandle.exitCode}`);
    try {
      const response = await fetch(`${origin}/health/live`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('packed process did not become live');
}

async function waitForReady(origin, token, processHandle) {
  let lastBody = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null)
      throw new Error(`packed process exited ${processHandle.exitCode}`);
    const response = await fetch(`${origin}/health/ready`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return response.json();
    assert.equal(response.status, 503);
    lastBody = await response.json();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const health = await mcp(origin, token, 999_999, 'tools/call', {
    name: 'search_admin',
    arguments: { action: 'health' },
  });
  throw new Error(
    `packed process did not recover readiness: ${JSON.stringify({ readiness: lastBody, search: health })}`,
  );
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}
