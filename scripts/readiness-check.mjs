import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.private, false);
assert.notEqual(manifest.version, '0.0.0');
assert.equal(manifest.peerDependencies['@gnolith/diamond'], '>=0.5.0-0 <0.6.0');
assert.equal(manifest.peerDependencies['@gnolith/taproot'], '>=0.5.0-0 <0.6.0');
assert.equal(
  manifest.repository.url,
  'git+https://github.com/gnolith/workshop.git',
);
assert.equal(
  manifest.scripts['release:boundary-check'],
  'node scripts/prepublish-check.mjs --verify-dry-run',
);
assert.equal(manifest.scripts.check.match(/npm run pack:check/gu)?.length, 1);
assert.equal(manifest.bin['gnolith-workshop'], './dist/cli.js');

const expectedExports = [
  '.',
  './backup',
  './bootstrap',
  './client',
  './executable',
  './local-adapter',
  './mcp',
  './migrations',
  './package.json',
  './protocol',
  './schemas/*',
  './server',
];
assert.deepEqual(Object.keys(manifest.exports).sort(), expectedExports);
for (const value of Object.values(manifest.exports)) {
  if (typeof value === 'string')
    assert.ok(
      existsSync(
        value.includes('*') ? value.slice(0, value.indexOf('*')) : value,
      ),
    );
  else {
    assert.ok(existsSync(value.import));
    assert.ok(existsSync(value.types));
  }
}

const sourceFiles = walk('src').filter((path) => /\.tsx?$/u.test(path));
const source = sourceFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
assert.doesNotMatch(source, /TODO|FIXME|no public API|coming soon/iu);

const migrationIds = readdirSync('migrations')
  .filter((name) => /\.sql$/u.test(name))
  .map((name) => name.replace(/\.sql$/u, ''));
assert.equal(new Set(migrationIds).size, migrationIds.length);
assert.deepEqual(migrationIds, [...migrationIds].sort());
assert.equal(migrationIds.at(-1), '0011_administration_control_plane');

const readme = readFileSync('README.md', 'utf8');
const architecture = readFileSync('docs/architecture-reset.md', 'utf8');
const breaking = readFileSync('docs/breaking-0.5.md', 'utf8');
const compatibility = readFileSync('COMPATIBILITY.md', 'utf8');
const peerArtifacts = JSON.parse(
  readFileSync('docs/peer-artifacts-v1.json', 'utf8'),
);
assert.ok(readme.includes('exactly 52 versioned operations'));
assert.ok(architecture.includes('Schema version 11'));
assert.ok(architecture.includes('does not inspect Taproot search tables'));
assert.ok(breaking.includes('Schema 11 is required'));
assert.ok(compatibility.includes('Diamond and Taproot 0.5'));
assert.equal(peerArtifacts.format, 'gnolith-workshop-peer-artifacts-v1');
assert.equal(peerArtifacts.version, 1);
assert.deepEqual(
  peerArtifacts.peers.map(({ name }) => name),
  ['diamond', 'taproot'],
);
assert.equal(
  peerArtifacts.peers[1].commit,
  'fa74e4550301fd575049d7c3703e39086ea93200',
);
assert.equal(
  peerArtifacts.peers[1].sha256,
  '8d7b42bd3c9a283f7cbcfa8579ae71296b6e571e1813998b4c460f6db1e0e2c4',
);
assert.equal(
  peerArtifacts.peers[1].canonicalEvidence.sbom.sha256,
  'c49c69b55db703a4284e60bc6d6e54c26044b391ff516f196306d21d8a8e47c9',
);
assert.ok(existsSync('schemas/workshop-config-v1.json'));
console.log('repository readiness invariants passed');

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
