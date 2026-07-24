/* global fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers';

const root = resolve(import.meta.dirname, '..');
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
try {
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@gnolith/workshop': `file:${tarball}`,
        '@gnolith/diamond': `file:${resolve(root, '..', 'diamond', 'gnolith-diamond-0.5.0.tgz')}`,
        '@gnolith/taproot': `file:${resolve(root, '..', 'taproot', 'gnolith-taproot-0.5.0.tgz')}`,
      },
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts'], {
    cwd: fixture,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
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
        id: 'packed-ollama-sqlite-v1',
        name: 'Packed Ollama SQLite',
        provider: {
          kind: 'ollama-compatible',
          endpoint: 'http://127.0.0.1:11434/',
          model: 'nomic-embed-text',
          dimensions: 768,
          metric: 'cosine',
          credentialSelector: null,
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        },
        vector: { kind: 'sqlite' },
      },
    }),
  );
  const semanticReceipt = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(fixture, 'node_modules', '@gnolith', 'workshop', 'dist', 'cli.js'),
        'configure-semantics-v1',
        '--config',
        join(fixture, 'config.json'),
        '--input',
        semanticInputPath,
      ],
      { cwd: fixture, encoding: 'utf8' },
    ),
  );
  assert.equal(semanticReceipt.configurationId, 'packed-ollama-sqlite-v1');
  assert.equal(semanticReceipt.revision, 1);
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
  let policyRevision = (
    await successfulToolCall(origin, token, 100, 'gnolith_status', {})
  ).authorizationRevision;
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
    action: 'effective-policy',
    target: { kind: 'entity', id: 'Q900' },
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
  const beforeIdenticalStatus = await successfulToolCall(
    origin,
    token,
    116,
    'gnolith_status',
    {},
  );
  const beforeIdenticalHealth = await successfulToolCall(
    origin,
    token,
    117,
    'search_admin',
    { action: 'health' },
  );
  const identicalCalls = await Promise.all(
    ['a', 'b'].map((suffix, index) =>
      successfulToolCall(origin, token, 118 + index, 'mutate_entity', {
        entityId: 'Q900',
        expectedRevision: 1,
        idempotencyKey: `packed-identical-label-${suffix}`,
        mutations: [
          {
            kind: 'label',
            authoredText: 'Preserve the packed restart item label.',
            value: {
              type: 'set-label',
              language: 'en',
              value: 'Packed restart item',
            },
          },
        ],
      }),
    ),
  );
  for (const identical of identicalCalls) {
    assert.equal(identical.changed, false);
    assert.equal(identical.newRevision, 1);
    assert.deepEqual(identical.quadPatch, { deleted: 0, inserted: 0 });
  }
  const afterIdenticalStatus = await successfulToolCall(
    origin,
    token,
    120,
    'gnolith_status',
    {},
  );
  const afterIdenticalHealth = await successfulToolCall(
    origin,
    token,
    121,
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
  let entityRevision = 1;
  for (const [index, value] of [
    'Packed restart item revision two',
    'Packed restart item revision three',
  ].entries()) {
    const changed = await successfulToolCall(
      origin,
      token,
      122 + index,
      'mutate_entity',
      {
        entityId: 'Q900',
        expectedRevision: entityRevision,
        idempotencyKey: `packed-changed-label-${index + 2}`,
        mutations: [
          {
            kind: 'label',
            authoredText: `Set packed label revision ${index + 2}.`,
            value: { type: 'set-label', language: 'en', value },
          },
        ],
      },
    );
    assert.equal(changed.changed, true);
    entityRevision = changed.newRevision;
  }
  assert.equal(entityRevision, 3);
  policyRevision = (
    await successfulToolCall(origin, token, 124, 'gnolith_status', {})
  ).authorizationRevision;
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
    125,
    'authorization_admin',
    visibilityArguments,
  );
  policyRevision = visibility.policyRevision;
  const visibilityReplay = await successfulToolCall(
    origin,
    token,
    126,
    'authorization_admin',
    visibilityArguments,
  );
  assert.equal(visibilityReplay.status, 'replayed');
  const visibilityConflict = await mcp(origin, token, 127, 'tools/call', {
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
    ],
  );
  process.stdout.write(
    `${JSON.stringify({ packedProcess: 'ok', catalogDigest: '7a66ccb7ed6c5ae33be526a318376b895d2ecb122d7e723fb3117baf8ad66224' })}\n`,
  );
} finally {
  if (child?.exitCode === null) await terminate(child);
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await rm(tarball, { force: true });
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null)
      throw new Error(`packed process exited ${processHandle.exitCode}`);
    const response = await fetch(`${origin}/health/ready`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return response.json();
    assert.equal(response.status, 503);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('packed process did not recover readiness');
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
