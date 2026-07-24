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
import { createOperationRuntime } from '@gnolith/workshop';
import { createWorkshopLocalExecutableAdapterV1 } from '@gnolith/workshop/local-adapter';
import {
  bindWorkshopProducerHandles,
  createAuthenticationVerifier,
  digestLocalBearerToken,
} from '@gnolith/workshop/server';

assertFactory(createWorkshopLocalExecutableAdapterV1);
function assertFactory(value) {
  if (typeof value !== 'function') throw new Error('packed local adapter factory is unavailable');
}

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const digest = await digestLocalBearerToken(bytes);
const expectation = {
  installationId: 'installation:packed',
  connectionId: 'connection:packed',
  registrationFingerprint: 'd'.repeat(64),
};
const binding = bindWorkshopProducerHandles(expectation, Object.fromEntries(
  ['task', 'memory', 'prompt'].map((kind) => [kind, {
    owner: '@gnolith/workshop',
    ...expectation,
    handle: Object.freeze({ opaque: crypto.randomUUID() }),
  }]),
));
const principal = {
  installationId: expectation.installationId,
  principalId: 'principal:packed',
  activeWorkspaceId: 'workspace:packed',
  capabilities: ['read'],
  authorizationRevision: 1,
  credentialId: 'credential:packed',
};
const status = {
  baseIri: 'https://packed.invalid/',
  migrations: { namespace: '@gnolith/workshop', version: 9, ready: true },
  compatibility: { diamond: true, taproot: true },
  canonicalReady: true,
  authorizationReady: true,
  lexicalReady: true,
  semantic: { state: 'unconfigured', configured: false },
  producers: {
    ready: true,
    fingerprint: expectation.registrationFingerprint,
    kinds: ['task', 'memory', 'prompt'],
  },
  blobReady: true,
};
export async function createWorkshopExecutable() {
  const authentication = createAuthenticationVerifier({
    profile: 'local-bearer-v1',
    credentials: {
      async findByDigest(candidate) {
        return candidate === digest ? {
          profile: 'local-bearer-v1',
          credentialId: principal.credentialId,
          tokenDigest: digest,
          installationId: principal.installationId,
          principalId: principal.principalId,
          activeWorkspaceId: principal.activeWorkspaceId,
          capabilities: principal.capabilities,
          authorizationRevision: principal.authorizationRevision,
          disabled: false,
        } : null;
      },
    },
    authorization: { async recheck() { return principal; } },
  });
  const operations = createOperationRuntime({
    version: '0.5.0',
    taproot: {
      async call() { return {}; },
      async createScopedSparqlView() { return {}; },
      async recheckPrincipal() { return principal; },
      async status() { return status; },
    },
    diamond: {
      async validate() { return {}; },
      async query() { return {}; },
    },
    workshop: { async call() { return {}; } },
  });
  return {
    version: '0.5.0',
    authentication,
    operations,
    producerBinding: { binding, expectation },
    async preflight() { return status; },
  };
}
`,
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
    }),
  );
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
  await terminate(child);
  process.stdout.write(
    `${JSON.stringify({ packedProcess: 'ok', catalogDigest: '577cc1de501b0ae3556eb1d32e7dd516c70a09c5b6226d671cec312068fba3dd' })}\n`,
  );
} finally {
  if (child?.exitCode === null) await terminate(child);
  await rm(fixture, { recursive: true, force: true });
  await rm(tarball, { force: true });
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
