/* global fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
  const created = await mcp(origin, token, 4, 'tools/call', {
    name: 'create_item',
    arguments: {
      idempotencyKey: 'packed-restart-item-v1',
      authoredText: 'Create an item immediately before a clean restart.',
      data: {
        id: 'Q1',
        labels: {
          en: { language: 'en', value: 'Packed restart item' },
        },
      },
    },
  });
  assert.equal(created.result?.isError, false, JSON.stringify(created));
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
  const corpusGeneration = lagged.activeCorpusGeneration;
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
  assert.match(await app.text(), /Packed Waystone/u);
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/app/%2e%2e/secret`)).status, 404);
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
    arguments: { entityId: 'Q1' },
  });
  assert.equal(item.result?.isError, false, JSON.stringify(item));
  assert.match(JSON.stringify(item.result.structuredContent), /"id":"Q1"/u);
  assert.match(
    JSON.stringify(item.result.structuredContent),
    /Packed restart item/u,
  );
  await terminate(child);
  process.stdout.write(
    `${JSON.stringify({ packedProcess: 'ok', catalogDigest: 'a57799a792a075a5e359567240a7241a48df4155fae3a9e73b092ccf9035955b' })}\n`,
  );
} finally {
  if (child?.exitCode === null) await terminate(child);
  await rm(fixture, { recursive: true, force: true });
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
