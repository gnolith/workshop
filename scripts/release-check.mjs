import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('release:check must be run through npm');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
assert.ok(tag, 'Pass a release tag such as v0.1.0');
assert.match(
  manifest.version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u,
);
assert.equal(tag, `v${manifest.version}`, 'tag must match package version');
assert.equal(manifest.private, false, 'Workshop must remain publishable');
assert.equal(
  manifest.repository.url,
  'https://github.com/gnolith/workshop.git',
);
assert.ok(
  readFileSync('CHANGELOG.md', 'utf8').includes(`## [${manifest.version}]`),
);
const [artifact] = JSON.parse(
  execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    encoding: 'utf8',
  }),
);
const files = new Set(artifact.files.map(({ path }) => path));
for (const path of [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CHANGELOG.md',
  'dist/index.js',
  'dist/protocol.js',
  'dist/server.js',
  'dist/mcp.js',
  'dist/site.js',
  'dist/ui.js',
  'dist/migrations.js',
  'dist/styles.css',
  'migrations/0001_workshop.sql',
  'docs/architecture.md',
  'docs/mcp.md',
  'docs/security.md',
  'docs/release-checklist.md',
  'docs/release-evidence.md',
  'docs/package-handoff.md',
  'examples/codex-site-canary/worker.ts',
])
  assert.ok(files.has(path), `packed artifact is missing ${path}`);
console.log(`release artifact validated for ${tag}`);
