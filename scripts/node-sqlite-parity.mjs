import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'workshop-node-sqlite-'));
const npmCli = findNpmCli();
const diamondTarball = process.env.DIAMOND_TARBALL
  ? resolve(process.env.DIAMOND_TARBALL)
  : packInstalledDiamond(root, npmCli);
const expectedSha256 = process.env.DIAMOND_TARBALL_SHA256;
if (expectedSha256) {
  assert.equal(
    createHash('sha256').update(readFileSync(diamondTarball)).digest('hex'),
    expectedSha256,
    'Diamond tarball SHA-256 does not match the pinned artifact',
  );
}

const [packed] = JSON.parse(
  execFileSync(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', root],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
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
    '@gnolith/taproot@0.4.0',
    workshopTarball,
  ],
  { cwd: root, stdio: 'inherit' },
);

writeFileSync(
  join(root, 'claim-worker.mjs'),
  `
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { bootstrapTaprootAuthorization, createTaprootHostWriteCapability } from '@gnolith/taproot';
import { createHmac } from 'node:crypto';
import { createWorkshopCore } from '@gnolith/workshop/core';
import { createWorkshopSearchIntegrationV1 } from '@gnolith/workshop/server';
const db = new NodeSqliteDatabase(process.argv[2], { busyTimeoutMs: 5_000 });
const AUTH = {
  installationId: 'parity:installation', principalId: process.argv[4],
  activeWorkspaceId: 'parity:workspace', workspaceIds: ['parity:workspace'],
  capabilities: ['read', 'task-write', 'memory-write', 'knowledge-write', 'admin', 'search:admin'],
  authorizationRevision: 1,
};
const TAPROOT = { baseIri: 'https://parity.workshop.gnolith.test' };
const hostKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('workshop-parity-host-key-32!!!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const hostCapability = createTaprootHostWriteCapability(db, TAPROOT, hostKey);
const search = await createWorkshopSearchIntegrationV1({ db, taproot: TAPROOT, hostCapability, installationId: AUTH.installationId, registrationContext: AUTH });
const core = createWorkshopCore({
  persistence: db,
  authorization: {
    getInstallationAuthorizationState: async () => ({ installationId: AUTH.installationId, authorizationRevision: 1, searchGeneration: 1 }),
    commitTaskMutation: async (_db, _context, mutation) => mutation.first(),
    commitMemoryMutation: async (_db, _context, mutation) => mutation.first(),
    commitTaskBackfill: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
    commitMemoryBackfill: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
    commitCursorSnapshot: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
  },
  knowledge: {
    authorizedReader: () => ({
      getEntity: async () => null,
      searchEntities: async () => ({ items: [], cursor: null }),
    }),
    health: async () => true,
  },
  diamondHealth: async () => true,
  cursorCodec: {
    currentGeneration: async () => 'parity-generation',
    digest: async (purpose, value) => createHmac('sha256', 'workshop-parity-cursor-key').update(purpose).update('\\0').update(value).digest('hex'),
    seal: async () => { throw new Error('pagination not exercised'); },
    open: async () => { throw new Error('pagination not exercised'); },
  },
  search,
});
try {
  await core.tasks.claim(process.argv[3], AUTH);
  console.log('fulfilled');
} catch {
  console.log('rejected');
} finally {
  await db.close();
}
`,
);

writeFileSync(
  join(root, 'parity.mjs'),
  `
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readAppliedMigrations } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { bootstrapTaprootAuthorization, createTaprootHostWriteCapability, initializeTaproot } from '@gnolith/taproot';
import { applyWorkshopMigrations, WORKSHOP_SCHEMA_VERSION, workshopMigrations } from '@gnolith/workshop/migrations';
import { createWorkshopCore } from '@gnolith/workshop/core';
import { backfillWorkshopAuthorizationBatch, createWorkshopSearchIntegrationV1, HealthService } from '@gnolith/workshop/server';

const path = join(${JSON.stringify(root)}, 'workshop.sqlite');
const TAPROOT = { baseIri: 'https://parity.workshop.gnolith.test' };
const AUTH = (principalId = 'owner') => ({
  installationId: 'parity:installation', principalId,
  activeWorkspaceId: 'parity:workspace', workspaceIds: ['parity:workspace'],
  capabilities: ['read', 'task-write', 'memory-write', 'knowledge-write', 'admin', 'search:admin'],
  authorizationRevision: 1,
});
const authorization = {
  getInstallationAuthorizationState: async () =>
    ({ installationId: 'parity:installation', authorizationRevision: 1, searchGeneration: 1 }),
  commitTaskMutation: async (_db, _context, mutation) => mutation.first(),
  commitMemoryMutation: async (_db, _context, mutation) => mutation.first(),
  commitTaskBackfill: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
  commitMemoryBackfill: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
  commitCursorSnapshot: async (_db, _context, _state, mutations) => _db.batch([...mutations]),
};
const options = {
  authorization,
  knowledge: {
    authorizedReader: () => ({
      getEntity: async () => null,
      searchEntities: async () => ({ items: [], cursor: null }),
    }),
    health: async () => true,
  },
  diamondHealth: async () => true,
  cursorCodec: {
    currentGeneration: async () => 'parity-generation',
    digest: async (purpose, value) => createHmac('sha256', 'workshop-parity-cursor-key').update(purpose).update('\\0').update(value).digest('hex'),
    seal: async () => { throw new Error('pagination not exercised'); },
    open: async () => { throw new Error('pagination not exercised'); },
  },
};
const searchFor = async (db, adopt = false) => {
  const hostKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('workshop-parity-host-key-32!!!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hostCapability = createTaprootHostWriteCapability(db, TAPROOT, hostKey);
  const search = await createWorkshopSearchIntegrationV1({ db, taproot: TAPROOT, hostCapability, installationId: AUTH().installationId, registrationContext: AUTH() });
  if (adopt) for (const domain of [search.task, search.memory, search.prompt]) await domain.producer.adoptLegacyPage(AUTH(), { limit: 100 });
  return search;
};
let first = new NodeSqliteDatabase(path);
await initializeTaproot(first, TAPROOT);
const bootstrapKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('workshop-parity-host-key-32!!!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
await bootstrapTaprootAuthorization(first, TAPROOT, createTaprootHostWriteCapability(first, TAPROOT, bootstrapKey), AUTH().installationId);
await applyWorkshopMigrations(first);
let search = await searchFor(first, true);
let core = createWorkshopCore({ persistence: first, ...options, search });
await assert.rejects(first.batch([
  first.prepare("INSERT INTO workshop_memories (slug, description, content, created_at, updated_at, revision) VALUES ('rollback-sentinel', 'Sentinel', 'Must roll back', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)"),
  first.prepare("INSERT INTO workshop_memories (slug, description, content, created_at, updated_at, revision) VALUES ('rollback-failure', NULL, 'Invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)"),
]));
assert.equal((await first.prepare(
  "SELECT COUNT(*) AS count FROM workshop_memories WHERE slug = 'rollback-sentinel'",
).first()).count, 0);
await core.memories.upsert('durable', { description: 'Durable', content: 'Across reopen' }, AUTH());
const created = await core.tasks.create({ description: 'Portable task', prompt: 'Persist this', memorySlugs: ['durable'] }, AUTH());
const memory = await core.memories.get('durable', AUTH());
const changedMemory = await core.memories.upsert('durable', {
  description: 'Durable', content: 'Revision two', expectedRevision: memory.revision,
}, AUTH());
assert.equal(changedMemory.revision, 2);
await assert.rejects(core.memories.upsert('durable', {
  description: 'Durable', content: 'Stale', expectedRevision: memory.revision,
}, AUTH()));

await first.close();

first = new NodeSqliteDatabase(path);
search = await searchFor(first);
core = createWorkshopCore({ persistence: first, ...options, search });
assert.equal((await core.tasks.get(created.id, AUTH())).description, 'Portable task');
assert.equal((await core.memories.get('durable', AUTH())).content, 'Revision two');
assert.deepEqual(await applyWorkshopMigrations(first), {
  previousVersion: WORKSHOP_SCHEMA_VERSION,
  version: WORKSHOP_SCHEMA_VERSION,
  applied: [],
});
const [recorded] = await readAppliedMigrations(first, '@gnolith/workshop');
await first.prepare(
  "UPDATE _gnolith_migrations SET checksum = 'tampered' WHERE namespace = '@gnolith/workshop' AND migration_id = ?",
).bind(recorded.id).run();
await assert.rejects(applyWorkshopMigrations(first));
await first.prepare(
  "UPDATE _gnolith_migrations SET checksum = ? WHERE namespace = '@gnolith/workshop' AND migration_id = ?",
).bind(recorded.checksum, recorded.id).run();
const health = await new HealthService({
  db: first,
  diamondHealth: core.diamondHealth,
  knowledge: core.knowledge,
  constructMcp: () => ({}),
}).inspect();
assert.equal(health.status, 'ok');
assert.equal(health.checks.persistence, true);
assert.equal(health.checks.d1, true);

const second = new NodeSqliteDatabase(path);
const competing = createWorkshopCore({ persistence: second, ...options, search: await searchFor(second) });
const outcomes = await Promise.allSettled([
  core.tasks.claim(created.id, AUTH('agent:first')),
  competing.tasks.claim(created.id, AUTH('agent:second')),
]);
assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
assert.equal((await core.tasks.get(created.id, AUTH())).claimed, true);
await second.close();
await first.close();

first = new NodeSqliteDatabase(path);
search = await searchFor(first);
core = createWorkshopCore({ persistence: first, ...options, search });
const processTask = await core.tasks.create({ description: 'Process contention', prompt: 'Claim once' }, AUTH());
await first.close();
const workerPath = join(${JSON.stringify(root)}, 'claim-worker.mjs');
const runClaim = (principal) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [workerPath, path, processTask.id, principal], {
    cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
});
const processOutcomes = await Promise.all([runClaim('process:a'), runClaim('process:b')]);
assert.deepEqual(processOutcomes.sort(), ['fulfilled', 'rejected'].sort());
first = new NodeSqliteDatabase(path);
search = await searchFor(first);
core = createWorkshopCore({ persistence: first, ...options, search });
assert.equal((await core.tasks.get(processTask.id, AUTH())).claimed, true);
await first.close();

const legacyPath = join(${JSON.stringify(root)}, 'workshop-v1.sqlite');
let legacy = new NodeSqliteDatabase(legacyPath);
await initializeTaproot(legacy, TAPROOT);
const legacyBootstrapKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('workshop-parity-host-key-32!!!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
await bootstrapTaprootAuthorization(legacy, TAPROOT, createTaprootHostWriteCapability(legacy, TAPROOT, legacyBootstrapKey), AUTH().installationId);
const legacyStatements = workshopMigrations[0].sql
  .split(/;\\s*(?:\\r?\\n|$)/u)
  .map((statement) => statement.trim())
  .filter(Boolean)
  .map((statement) => legacy.prepare(statement));
await legacy.batch(legacyStatements);
await legacy.batch([
  legacy.prepare("INSERT INTO workshop_memories (slug, description, content, created_at, updated_at) VALUES ('legacy-memory', 'Legacy', 'Before migration', '2026-07-20 12:00:00', '2026-07-20 12:00:00')"),
  legacy.prepare("INSERT INTO workshop_tasks (id, description, prompt, context_queries, memory_slugs, claimed, created_at, updated_at) VALUES ('legacy-update', 'Legacy update', 'Before migration', '[]', json_array('legacy-memory'), 0, '2026-07-20 12:00:00', '2026-07-20 12:00:00')"),
  legacy.prepare("INSERT INTO workshop_tasks (id, description, prompt, context_queries, memory_slugs, claimed, created_at, updated_at) VALUES ('legacy-archive', 'Legacy archive', 'Before migration', '[]', '[]', 0, '2026-07-20 12:00:00', '2026-07-20 12:00:00')"),
]);
await applyWorkshopMigrations(legacy);
const legacyRecords = await readAppliedMigrations(legacy, '@gnolith/workshop');
assert.deepEqual(legacyRecords.map(({ adopted }) => adopted), [
  true,
  false,
  false,
  false,
  false,
  false,
]);
const legacySearch = await searchFor(legacy);
const legacyCore = createWorkshopCore({ persistence: legacy, ...options, search: legacySearch });
await assert.rejects(legacyCore.memories.get('legacy-memory', AUTH()));
await assert.rejects(legacyCore.tasks.get('legacy-update', AUTH()));
await backfillWorkshopAuthorizationBatch(legacy, authorization, AUTH(), { domain: 'memory' });
await backfillWorkshopAuthorizationBatch(legacy, authorization, AUTH(), { domain: 'task' });
for (const domain of [legacySearch.task, legacySearch.memory, legacySearch.prompt]) await domain.producer.adoptLegacyPage(AUTH(), { limit: 100 });
const legacyMemory = await legacyCore.memories.get('legacy-memory', AUTH());
assert.equal((await legacyCore.memories.upsert('legacy-memory', {
  description: 'Legacy', content: 'Migrated', expectedUpdatedAt: legacyMemory.updatedAt,
}, AUTH())).revision, 2);
const legacyTask = await legacyCore.tasks.get('legacy-update', AUTH());
assert.equal((await legacyCore.tasks.update('legacy-update', {
  expectedUpdatedAt: legacyTask.updatedAt, prompt: 'Migrated update',
}, AUTH())).revision, 2);
const legacyArchive = await legacyCore.tasks.get('legacy-archive', AUTH());
assert.equal((await legacyCore.tasks.archive('legacy-archive', {
  expectedUpdatedAt: legacyArchive.updatedAt,
}, AUTH())).archivedAt !== undefined, true);
await legacy.close();
console.log('Workshop packed-artifact node:sqlite reopen, migrations, revisions, health, connection and process contention parity passed');
`,
);
execFileSync(process.execPath, [join(root, 'parity.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
console.log(
  `verified ${basename(workshopTarball)} with ${basename(diamondTarball)}`,
);

function fail(message) {
  throw new Error(message);
}

function packInstalledDiamond(destination, npmCli) {
  const installed = resolve('node_modules/@gnolith/diamond');
  if (!existsSync(installed))
    fail('DIAMOND_TARBALL is required when @gnolith/diamond is not installed');
  const [packed] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npmCli,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        destination,
      ],
      { cwd: installed, encoding: 'utf8' },
    ),
  );
  return join(destination, packed.filename);
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(
      dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    ...String(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  const npmCli = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!npmCli) throw new Error('Unable to locate npm-cli.js');
  return npmCli;
}
