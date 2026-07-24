import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json')));
const head = run('git', ['rev-parse', 'HEAD']).trim();
if (run('git', ['status', '--porcelain']).trim())
  throw new Error('Candidate preparation requires a clean committed tree');
if (!/^[a-f0-9]{40}$/u.test(head))
  throw new Error('Candidate commit is invalid');
const output = resolve(
  root,
  '.artifacts',
  `${manifest.name.split('/').at(-1)}-${manifest.version}-${head}`,
);
await mkdir(output, { recursive: true });
run('npm', ['pack', '--pack-destination', output], { stdout: 'inherit' });
const artifact = resolve(output, `gnolith-workshop-${manifest.version}.tgz`);
const sbomText = run('npm', [
  'sbom',
  '--omit=dev',
  '--sbom-format',
  'cyclonedx',
]);
const sbom = resolve(
  output,
  `gnolith-workshop-${manifest.version}.sbom.cdx.json`,
);
await writeFile(sbom, `${sbomText.trim()}\n`);
const artifactSha256 = await sha256(artifact);
const sbomSha256 = await sha256(sbom);
const migrationIds = [
  '0001_workshop',
  '0002_revisions',
  '0003_resumable_onboarding',
  '0004_authorization',
  '0005_cursor_snapshots',
  '0006_canonical_search_domains',
  '0007_task_leases',
  '0008_bootstrap_credentials',
  '0009_operation_receipts',
  '0010_durable_mutation_receipts',
  '0011_administration_control_plane',
];
const inventory = {
  format: 'gnolith-workshop-candidate-v1',
  package: manifest.name,
  version: manifest.version,
  commit: head,
  artifact,
  artifactSha256,
  sbom,
  sbomSha256,
  catalogDigest:
    'e2d1e0f09e4dbad786d14cb4a9dd86dbe56a64d274e252bbbb1956b2c8933c85',
  schemaVersion: 11,
  migrationNamespace: '@gnolith/workshop',
  migrations: await Promise.all(
    migrationIds.map(async (id) => ({
      id,
      checksum: `sha256:${await migrationChecksum(
        resolve(root, 'migrations', `${id}.sql`),
      )}`,
    })),
  ),
  configSchema: 'schemas/workshop-config-v1.json',
  blobFactory:
    '@gnolith/workshop/backup#createLocalFilesystemResourceBlobPortsV1',
  mcpServerName: 'gnolith',
  createdAt: new Date().toISOString(),
};
const inventoryPath = resolve(output, 'candidate-inventory.json');
await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(
  resolve(output, 'SHA256SUMS'),
  `${artifactSha256}  ${artifact.split(/[\\/]/u).at(-1)}\n${sbomSha256}  ${sbom.split(/[\\/]/u).at(-1)}\n${await sha256(inventoryPath)}  candidate-inventory.json\n`,
);
process.stdout.write(`${JSON.stringify({ ...inventory, inventoryPath })}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `${command} failed`);
  return result.stdout ?? '';
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function migrationChecksum(path) {
  return createHash('sha256')
    .update((await readFile(path, 'utf8')).replace(/\r\n/gu, '\n').trim())
    .digest('hex');
}
