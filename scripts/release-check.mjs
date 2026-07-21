import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  assertVersionIsUnambiguous,
  loadAndVerifyArtifact,
} from './artifact-provenance.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('release:check must be run through npm');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
assert.ok(tag, `Pass a release tag such as v${manifest.version}`);
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
assertVersionIsUnambiguous(manifest, {
  ref: `refs/tags/${tag}`,
  requireHead: true,
});
const { provenance } = await loadAndVerifyArtifact();
assert.equal(
  provenance.source.dirty,
  false,
  'Release provenance must be generated from a clean checkout',
);
const head = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
assert.equal(provenance.source.commit, head);
assert.equal(provenance.source.tree, tree);
assert.equal(
  git(['cat-file', '-t', `refs/tags/${tag}`], true),
  'tag',
  `Release tag ${tag} must exist locally and be annotated`,
);
assert.equal(
  git(['rev-list', '-n', '1', `refs/tags/${tag}`]),
  head,
  `Release tag ${tag} must resolve to the provenance commit`,
);
const files = new Set(provenance.artifact.files.map(({ path }) => path));
for (const path of [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CHANGELOG.md',
  'dist/index.js',
  'dist/core.js',
  'dist/protocol.js',
  'dist/server.js',
  'dist/mcp.js',
  'dist/site.js',
  'dist/ui.js',
  'dist/migrations.js',
  'dist/styles.css',
  'migrations/0001_workshop.sql',
  'migrations/0002_revisions.sql',
  'migrations/0003_resumable_onboarding.sql',
  'docs/architecture.md',
  'docs/mcp.md',
  'docs/security.md',
  'docs/release-checklist.md',
  'docs/release-evidence.md',
  'docs/release-provenance.md',
  'docs/release-provenance.schema.json',
  'docs/package-handoff.md',
])
  assert.ok(files.has(path), `packed artifact is missing ${path}`);
console.log(
  `release artifact validated for ${tag} at ${provenance.source.commit} (${provenance.artifact.sha256})`,
);

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}
