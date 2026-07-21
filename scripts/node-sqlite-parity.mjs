import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const diamondTarball = resolve(
  process.env.DIAMOND_TARBALL ?? fail('DIAMOND_TARBALL is required'),
);
const expectedSha256 = process.env.DIAMOND_TARBALL_SHA256;
if (expectedSha256) {
  assert.equal(
    createHash('sha256').update(readFileSync(diamondTarball)).digest('hex'),
    expectedSha256,
    'Diamond tarball SHA-256 does not match the pinned artifact',
  );
}

const root = mkdtempSync(join(tmpdir(), 'workshop-node-sqlite-'));
const npmCli = findNpmCli();
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
    workshopTarball,
  ],
  { cwd: root, stdio: 'inherit' },
);

writeFileSync(
  join(root, 'claim-worker.mjs'),
  `
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createWorkshopCore } from '@gnolith/workshop/core';
const db = new NodeSqliteDatabase(process.argv[2], { busyTimeoutMs: 5_000 });
const core = createWorkshopCore({
  persistence: db,
  executeSparql: async () => ({ type: 'boolean', data: true, truncated: false }),
  knowledge: { call: async () => ({}), health: async () => true },
});
try {
  await core.tasks.claim(process.argv[3], process.argv[4]);
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
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readAppliedMigrations } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { applyWorkshopMigrations, WORKSHOP_SCHEMA_VERSION } from '@gnolith/workshop/migrations';
import { createWorkshopCore } from '@gnolith/workshop/core';
import { HealthService, OnboardingService, SqlOnboardingCheckpointStore } from '@gnolith/workshop/server';

const path = join(${JSON.stringify(root)}, 'workshop.sqlite');
const options = {
  executeSparql: async () => ({ type: 'boolean', data: true, truncated: false }),
  knowledge: { call: async () => ({}), health: async () => true },
};
let first = new NodeSqliteDatabase(path);
await applyWorkshopMigrations(first);
let core = createWorkshopCore({ persistence: first, ...options });
await assert.rejects(first.batch([
  first.prepare("INSERT INTO workshop_memories (slug, description, content, created_at, updated_at, revision) VALUES ('rollback-sentinel', 'Sentinel', 'Must roll back', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)"),
  first.prepare("INSERT INTO workshop_memories (slug, description, content, created_at, updated_at, revision) VALUES ('rollback-failure', NULL, 'Invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)"),
]));
assert.equal((await first.prepare(
  "SELECT COUNT(*) AS count FROM workshop_memories WHERE slug = 'rollback-sentinel'",
).first()).count, 0);
await core.memories.upsert('durable', { description: 'Durable', content: 'Across reopen' });
const created = await core.tasks.create({ description: 'Portable task', prompt: 'Persist this', memorySlugs: ['durable'] });
const memory = await core.memories.get('durable');
const changedMemory = await core.memories.upsert('durable', {
  description: 'Durable', content: 'Revision two', expectedRevision: memory.revision,
});
assert.equal(changedMemory.revision, 2);
await assert.rejects(core.memories.upsert('durable', {
  description: 'Durable', content: 'Stale', expectedRevision: memory.revision,
}));

let tick = Date.parse('2026-07-21T00:00:00.000Z');
const store = new SqlOnboardingCheckpointStore(first);
let interrupt = true;
const interruptedStore = new Proxy(store, {
  get(target, property, receiver) {
    if (property === 'completeStep') return async (...args) => {
      if (interrupt) { interrupt = false; throw new Error('simulated interruption'); }
      return target.completeStep(...args);
    };
    return Reflect.get(target, property, receiver);
  },
});
const onboarding = (checkpointStore, persistenceCore = core) => new OnboardingService(
  persistenceCore.tasks,
  persistenceCore.memories,
  { createItem: async () => { throw new Error('unexpected entity step'); } },
  {
    store: checkpointStore,
    clock: () => new Date(++tick),
    createLeaseToken: () => 'lease-' + tick,
    leaseDurationMs: 2,
  },
);
const plan = onboarding(interruptedStore).plan({
  key: 'portable-onboarding', scopeBoundaries: 'Persist every checkpoint.',
});
await assert.rejects(onboarding(interruptedStore).apply(plan, 'owner'));
await first.close();

first = new NodeSqliteDatabase(path);
core = createWorkshopCore({ persistence: first, ...options });
tick += 10;
const resumed = await onboarding(new SqlOnboardingCheckpointStore(first), core).resume(plan.key, 'owner');
assert.equal(resumed.state, 'completed');
assert.equal(resumed.completedSteps, 1);
assert.equal((await core.tasks.get(created.id)).description, 'Portable task');
assert.equal((await core.memories.get('durable')).content, 'Revision two');
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
  sparql: core.sparql,
  knowledge: core.knowledge,
  constructMcp: () => ({}),
}).inspect();
assert.equal(health.status, 'ok');
assert.equal(health.checks.persistence, true);
assert.equal(health.checks.d1, true);

const second = new NodeSqliteDatabase(path);
const competing = createWorkshopCore({ persistence: second, ...options });
const outcomes = await Promise.allSettled([
  core.tasks.claim(created.id, 'agent:first'),
  competing.tasks.claim(created.id, 'agent:second'),
]);
assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
assert.equal((await core.tasks.get(created.id)).claimed, true);
await second.close();
await first.close();

first = new NodeSqliteDatabase(path);
core = createWorkshopCore({ persistence: first, ...options });
const processTask = await core.tasks.create({ description: 'Process contention', prompt: 'Claim once' });
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
core = createWorkshopCore({ persistence: first, ...options });
assert.equal((await core.tasks.get(processTask.id)).claimed, true);
await first.close();
console.log('Workshop packed-artifact node:sqlite reopen, migrations, revisions, onboarding, health, connection and process contention parity passed');
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
