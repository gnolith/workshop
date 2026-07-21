import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.private, false);
assert.notEqual(manifest.version, '0.0.0');

const expectedExports = [
  '.',
  './mcp',
  './migrations',
  './package.json',
  './protocol',
  './server',
  './site',
  './styles.css',
  './ui',
];
assert.deepEqual(Object.keys(manifest.exports).sort(), expectedExports);
for (const value of Object.values(manifest.exports)) {
  if (typeof value === 'string') assert.ok(existsSync(value));
  else {
    assert.ok(existsSync(value.import));
    assert.ok(existsSync(value.types));
  }
}

const sourceFiles = walk('src').filter((path) => /\.tsx?$/u.test(path));
const source = sourceFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
assert.doesNotMatch(source, /TODO|FIXME|no public API|coming soon/iu);

const browserFiles = [
  ...walk('src/ui').filter((path) => /\.tsx?$/u.test(path)),
  ...walk('src/protocol').filter((path) => /\.ts$/u.test(path)),
  'src/ui.ts',
  'src/protocol.ts',
];
const browserSource = browserFiles
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
assert.doesNotMatch(
  browserSource,
  /(?:from|import\()\s*['"][^'"]*\/(?:server|mcp|site)(?:\/|['"])/u,
);
assert.doesNotMatch(browserSource, /['"]node:/u);
assert.ok(readFileSync('src/ui.ts', 'utf8').startsWith("'use client';"));
assert.ok(browserSource.includes('createWorkshopPlugin'));

const migrationIds = readdirSync('migrations')
  .filter((name) => /\.sql$/u.test(name))
  .map((name) => name.replace(/\.sql$/u, ''));
assert.equal(new Set(migrationIds).size, migrationIds.length);
assert.deepEqual(migrationIds, [...migrationIds].sort());

const readme = readFileSync('README.md', 'utf8');
const evidence = readFileSync('docs/release-evidence.md', 'utf8');
assert.ok(readme.includes('@gnolith/workshop/site'));
assert.ok(evidence.includes('Workshop package handoff ready'));
assert.ok(evidence.includes('isolated package-runtime consumers'));
assert.ok(evidence.includes('does not qualify a'));
assert.ok(evidence.includes('complete Gnolith Site'));
assert.ok(evidence.includes('machine-verifiable record'));
assert.ok(existsSync('docs/release-provenance.schema.json'));
console.log('repository readiness invariants passed');

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
