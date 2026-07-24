/* global fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
        '@gnolith/taproot': `file:${resolve(root, '..', 'taproot-artifacts', 'gnolith-taproot-0.5.0.tgz')}`,
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
import { fileURLToPath } from 'node:url';
import {
  createWorkshopLocalExecutableAdapterFromPrimitivesV1,
} from '@gnolith/workshop/local-adapter';
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
`,
  );
  const credentialPath = join(fixture, 'credential.txt');
  writeFileSync(credentialPath, token);
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
  assert.deepEqual(await (await fetch(`${origin}/health/live`)).json(), {
    status: 'live',
  });
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
  const tools = await mcp(origin, token, 2, 'tools/list', {});
  assert.equal(tools.result.tools.length, 51);
  const status = await mcp(origin, token, 3, 'tools/call', {
    name: 'gnolith_status',
    arguments: {},
  });
  assert.equal(status.result?.isError, false, JSON.stringify(status));
  assert.equal(status.result.structuredContent.blobReady, true);
  await terminate(child);
  process.stdout.write(
    `${JSON.stringify({ packedProcess: 'ok', catalogDigest: '577cc1de501b0ae3556eb1d32e7dd516c70a09c5b6226d671cec312068fba3dd' })}\n`,
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
