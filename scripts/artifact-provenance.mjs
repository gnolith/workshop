import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release, version as osVersion } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import tar from 'tar-stream';

export const projectRoot = resolve('.');
export const releaseRoot = join(projectRoot, '.release');

const packageInputs = [
  '.gitattributes',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'src',
  'migrations',
  'docs',
  'scripts',
  'README.md',
  'CHANGELOG.md',
  'COMPATIBILITY.md',
  'SECURITY.md',
  'LICENSE',
];

export function readManifest() {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
}

export function artifactNames(manifest = readManifest()) {
  const stem = `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}`;
  return {
    archive: `${stem}.tgz`,
    provenance: `${stem}.provenance.json`,
  };
}

export function artifactPaths(manifest = readManifest()) {
  const names = artifactNames(manifest);
  return {
    archive: join(releaseRoot, names.archive),
    provenance: join(releaseRoot, names.provenance),
  };
}

export function assertVersionIsUnambiguous(manifest = readManifest()) {
  const commits = git(['log', '--format=%H', '--all', '--', 'package.json'])
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const commit of commits) {
    let historical;
    try {
      historical = JSON.parse(git(['show', `${commit}:package.json`]));
    } catch {
      continue;
    }
    if (historical.version !== manifest.version) continue;
    const comparison = spawnSync(
      'git',
      ['diff', '--quiet', commit, '--', ...packageInputs],
      { cwd: projectRoot, stdio: 'ignore' },
    );
    assert.notEqual(
      comparison.status,
      1,
      `Package version ${manifest.version} already exists at ${commit.slice(0, 12)} with different artifact inputs; bump the version`,
    );
    assert.equal(
      comparison.status,
      0,
      'Unable to compare package version history',
    );
  }
}

export function sourceIdentity() {
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const diff = git(['diff', '--binary', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
  return {
    commit,
    tree,
    dirty: Boolean(status),
    stateSha256: sha256(JSON.stringify({ diff, untracked })),
  };
}

export function environmentIdentity() {
  return {
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    node: process.version,
    npm: npm(['--version']),
    git: git(['--version']),
    coreAutocrlf: git(['config', '--get', 'core.autocrlf'], true) || null,
  };
}

export function prepareArtifact() {
  const manifest = readManifest();
  assertVersionIsUnambiguous(manifest);
  mkdirSync(releaseRoot, { recursive: true });
  const names = artifactNames(manifest);
  for (const name of readdirSync(releaseRoot)) {
    if (name === names.archive || name === names.provenance) {
      unlinkSync(join(releaseRoot, name));
    }
  }
  const source = sourceIdentity();
  const [packed] = JSON.parse(
    npm(['pack', '--json', '--pack-destination', releaseRoot]),
  );
  assert.equal(packed.filename, names.archive);
  const archive = join(releaseRoot, packed.filename);
  const bytes = readFileSync(archive);
  const provenance = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    package: { name: manifest.name, version: manifest.version },
    source,
    environment: environmentIdentity(),
    artifact: {
      filename: packed.filename,
      size: statSync(archive).size,
      sha256: sha256(bytes),
      shasum: sha1(bytes),
      integrity: sha512Integrity(bytes),
      files: [...packed.files]
        .map(({ path, size, mode }) => ({ path, size, mode }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  assert.equal(provenance.artifact.shasum, packed.shasum);
  assert.equal(provenance.artifact.integrity, packed.integrity);
  validateProvenance(provenance);
  writeFileSync(
    join(releaseRoot, names.provenance),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return { archive, provenance };
}

export async function loadAndVerifyArtifact() {
  const manifest = readManifest();
  const paths = artifactPaths(manifest);
  assert.ok(existsSync(paths.provenance), 'Run npm run artifact:prepare first');
  assert.ok(existsSync(paths.archive), 'Prepared package archive is missing');
  const provenance = JSON.parse(readFileSync(paths.provenance, 'utf8'));
  validateProvenance(provenance);
  assert.deepEqual(provenance.package, {
    name: manifest.name,
    version: manifest.version,
  });
  assert.deepEqual(provenance.source, sourceIdentity());
  const bytes = readFileSync(paths.archive);
  assert.equal(provenance.artifact.filename, basename(paths.archive));
  assert.equal(provenance.artifact.size, bytes.byteLength);
  assert.equal(provenance.artifact.sha256, sha256(bytes));
  assert.equal(provenance.artifact.shasum, sha1(bytes));
  assert.equal(provenance.artifact.integrity, sha512Integrity(bytes));
  assert.ok(Array.isArray(provenance.artifact.files));
  assert.ok(provenance.artifact.files.length > 0);
  const packed = await inspectPackedArchive(paths.archive);
  assert.deepEqual(
    packed.manifest,
    provenance.artifact.files,
    'Retained archive contents differ from the provenance file manifest',
  );
  await verifyPackedContract(packed.files, manifest);
  return { archive: paths.archive, provenance };
}

function validateProvenance(provenance) {
  const schema = JSON.parse(
    readFileSync(
      join(projectRoot, 'docs/release-provenance.schema.json'),
      'utf8',
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(
    validate(provenance),
    `Invalid artifact provenance: ${ajv.errorsText(validate.errors)}`,
  );
}

async function inspectPackedArchive(archive) {
  const extract = tar.extract();
  const files = new Map();
  const manifest = [];
  const completed = new Promise((resolvePromise, rejectPromise) => {
    extract.on('entry', (header, stream, next) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', rejectPromise);
      stream.on('end', () => {
        if (header.type === 'file') {
          assert.ok(
            header.name.startsWith('package/'),
            `Unexpected archive path ${header.name}`,
          );
          const path = header.name.slice('package/'.length);
          const bytes = Buffer.concat(chunks);
          files.set(path, bytes);
          manifest.push({
            path,
            size: bytes.byteLength,
            mode: (header.mode ?? 0) & 0o777,
          });
        }
        next();
      });
    });
    extract.on('finish', () =>
      resolvePromise({
        files,
        manifest: manifest.sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
      }),
    );
    extract.on('error', rejectPromise);
  });
  createReadStream(archive).pipe(createGunzip()).pipe(extract);
  return completed;
}

async function verifyPackedContract(files, sourceManifest) {
  const packedManifestBytes = files.get('package.json');
  assert.ok(packedManifestBytes, 'Packed archive is missing package.json');
  const packedManifest = JSON.parse(packedManifestBytes.toString('utf8'));
  assert.equal(packedManifest.name, sourceManifest.name);
  assert.equal(packedManifest.version, sourceManifest.version);
  for (const target of exportTargets(packedManifest.exports)) {
    assert.match(target, /^\.\//u, `Invalid packed export target ${target}`);
    assert.ok(
      files.has(target.slice(2)),
      `Packed export target is missing: ${target}`,
    );
  }

  const compiledManifestBytes = files.get('dist/migrations/manifest.js');
  assert.ok(
    compiledManifestBytes,
    'Packed archive is missing its compiled migration manifest',
  );
  const moduleUrl = `data:text/javascript;base64,${compiledManifestBytes.toString('base64')}`;
  const compiledManifest = await import(moduleUrl);
  const expectedMigrationPaths = compiledManifest.workshopMigrations.map(
    ({ id }) => `migrations/${id}.sql`,
  );
  const packedMigrationPaths = [...files.keys()]
    .filter((path) => /^migrations\/.*\.sql$/u.test(path))
    .sort();
  assert.deepEqual(
    packedMigrationPaths,
    [...expectedMigrationPaths].sort(),
    'Packed migration files differ from the compiled manifest',
  );
  for (const migration of compiledManifest.workshopMigrations) {
    const path = `migrations/${migration.id}.sql`;
    const bytes = files.get(path);
    assert.ok(bytes, `Packed migration is missing: ${path}`);
    const normalized = bytes.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(
      normalized,
      `${migration.sql}\n`,
      `${path} bytes differ from the packed compiled manifest`,
    );
    assert.equal(
      migration.checksum,
      `sha256:${sha256(migration.sql)}`,
      `${path} checksum differs from the packed compiled manifest SQL`,
    );
  }
}

function exportTargets(exportsField) {
  if (typeof exportsField === 'string') return [exportsField];
  assert.ok(
    exportsField &&
      typeof exportsField === 'object' &&
      !Array.isArray(exportsField),
    'Packed package exports must be strings or nested objects',
  );
  return Object.values(exportsField).flatMap(exportTargets);
}

function npm(args) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run artifact tooling through npm');
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
}

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function sha512Integrity(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}
