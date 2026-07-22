import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(
  new URL('../workflows/release.yml', import.meta.url),
  'utf8',
);
const ciWorkflow = await readFile(
  new URL('../workflows/ci.yml', import.meta.url),
  'utf8',
);
const releasePolicy = await readFile(
  new URL('../release-policy.md', import.meta.url),
  'utf8',
);
const workflowSha256 = createHash('sha256').update(workflow).digest('hex');
const expectedWorkflowSha256 =
  '9177c8dbf0a75c85e79389f24390c0d83bdad8937a763ca1fa661ac3064f1315';

const build = job('build-and-verify', 'publish');
const publish = job('publish', 'publish-release');
const evidence = tailJob('publish-release');
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));

assert.equal(
  workflowSha256,
  expectedWorkflowSha256,
  'release.yml changed; preserve the reviewed boundary and deliberately update its guard digest',
);
assert.match(workflow, /^permissions: \{\}$/mu);
assert.match(workflow, /^on:\n  push:\n    tags:\n      - 'v\*\.\*\.\*'$/mu);
assert.doesNotMatch(workflow, /github\.event\.release|^  release:/mu);
assert.equal(
  count(jobs, /^  [a-z][a-z-]+:$/gmu),
  3,
  'release workflow must have exactly three jobs',
);
assert.equal(
  count(workflow, /environment: npm/gu),
  1,
  'only publish may use the npm environment',
);
assert.equal(
  count(workflow, /NPM_BOOTSTRAP_TOKEN|NODE_AUTH_TOKEN|secrets\./gu),
  0,
  'release workflow must not reference npm credentials or GitHub secrets',
);
assert.equal(
  count(workflow, /npm publish/gu),
  1,
  'npm publish must appear exactly once',
);
assert.match(
  ciWorkflow,
  /run: node \.github\/scripts\/test-release-boundary-runtime\.mjs/u,
);
assert.match(releasePolicy, /publishes only through npm trusted publishing/u);
assert.match(
  releasePolicy,
  /no npm access token, bootstrap secret, or `NODE_AUTH_TOKEN`/u,
);
assert.equal(count(workflow, /assert\.deepEqual\(statement\.subject/gu), 2);
for (const fragment of [
  'expected exactly one SLSA provenance attestation',
  'application/vnd.in-toto+json',
  'SLSA provenance signature missing',
  'https://in-toto.io/Statement/v1',
  'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
])
  assert.equal(
    countLiteral(workflow, fragment),
    2,
    `both npm provenance checks must enforce ${fragment}`,
  );
const exactBuildType =
  'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
assert.equal(
  countLiteral(
    workflow.replace(exactBuildType, exactBuildType.replace('.io', 'Xio')),
    exactBuildType,
  ),
  1,
  'build-type verification must treat dotted URL characters literally',
);
assert.equal(
  count(
    workflow,
    /this job does not perform local Sigstore bundle cryptographic verification\./gu,
  ),
  2,
);

ordered(build, [
  'outputs:\n      package_sha256: ${{ steps.assemble.outputs.package_sha256 }}',
  'tag_commit: ${{ steps.tag-identity.outputs.tag_commit }}',
  'permissions:\n      contents: read',
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4',
  'ref: ${{ github.ref_name }}',
  'persist-credentials: false',
  '- name: Verify annotated tag identity and main ancestry',
  '[[ "$(git cat-file -t "$tag_ref")" == \'tag\' ]]',
  'tag_commit="$(git rev-list -n 1 "$tag_ref")"',
  '[[ "$tag_commit" == "$(git rev-parse HEAD)" ]]',
  'git fetch --no-tags origin main',
  'git merge-base --is-ancestor "$tag_commit" origin/main',
  'printf \'tag_commit=%s\\n\' "$tag_commit" >> "$GITHUB_OUTPUT"',
  '- name: Refuse a preexisting GitHub Release before npm publication',
  'GH_TOKEN: ${{ github.token }}',
  'signal: AbortSignal.timeout(30_000)',
  "throw new Error('GitHub Release existence could not be determined');",
  'Number.isInteger(response.status) && response.status >= 100 && response.status <= 599',
  'if (response.status === 404)',
  "throw new Error('GitHub Release already exists; refusing npm publication');",
  'GitHub Release existence check failed with HTTP ${response.status}',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4',
  '- run: npm ci',
  '- run: npm run check',
  '- run: npm run release:check -- "${{ github.ref_name }}"',
  '- name: Assemble immutable release boundary',
  "const sha256 = createHash('sha256').update(bytes).digest('hex');",
  'const filename = `${base}-${sha256}.tgz`;',
  "assert.equal(packageManifest.name, '@gnolith/workshop');",
  'assert.equal(process.env.RELEASE_TAG, `v${packageManifest.version}`);',
  'assert.equal(provenance.artifact.sha256, sha256);',
  'packageName: packageManifest.name,',
  'version: packageManifest.version,',
  'filename,',
  'sha256,',
  "join(boundary, 'release-manifest.json')",
  '`package_sha256=${sha256}\\n`',
  '- name: Upload verified release boundary',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  'name: release-boundary-${{ github.ref_name }}',
  'path: ${{ runner.temp }}/release-boundary',
  'retention-days: 30',
  '- name: Upload verified provenance evidence',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  'name: release-evidence-${{ github.ref_name }}-${{ steps.assemble.outputs.package_sha256 }}',
  'path: ${{ runner.temp }}/release-evidence',
  'retention-days: 30',
]);
assert.doesNotMatch(
  build,
  /environment: npm|secrets\.|NODE_AUTH_TOKEN|npm publish/u,
);
assert.equal(count(build, /GH_TOKEN: \$\{\{ github\.token \}\}/gu), 1);
assert.equal(count(build, /actions\/upload-artifact@/gu), 2);
assert.equal(count(build, /retention-days: 30/gu), 2);

ordered(publish, [
  'needs: build-and-verify',
  'environment: npm',
  'permissions:\n      id-token: write\n    steps:',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4',
  'registry-url: https://registry.npmjs.org',
  '- name: Download exact verified release boundary',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
  'name: release-boundary-${{ github.ref_name }}',
  'path: ${{ runner.temp }}/release-boundary',
  '- name: Revalidate release boundary',
  'EXPECTED_SHA256: ${{ needs.build-and-verify.outputs.package_sha256 }}',
  'const root = resolve(process.env.RELEASE_BOUNDARY);',
  'release tag must contain an unambiguous semver version',
  'release boundary must contain exactly two files',
  'release boundary contains an unexpected file',
  'stat.isFile() && !stat.isSymbolicLink()',
  "const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');",
  "assert.equal(manifest.packageName, '@gnolith/workshop');",
  'assert.equal(manifest.version, expectedVersion);',
  "assert.equal(manifest.sha256, process.env.EXPECTED_SHA256, 'manifest digest differs from build anchor');",
  "assert.equal(actualSha256, manifest.sha256, 'release archive sha256 mismatch');",
  "assert.equal(actualSha256, process.env.EXPECTED_SHA256, 'archive digest differs from build anchor');",
  'const expectedFilename = `gnolith-workshop-${expectedVersion}-${manifest.sha256}.tgz`;',
  'assert.doesNotMatch(path, /\\\\/u',
  "assert.ok(!path.startsWith('/'),",
  'assert.doesNotMatch(path, /^[A-Za-z]:/u',
  "component !== '' && component !== '.' && component !== '..'",
  'assert.ok(!paths.has(path), `duplicate tar entry path: ${path}`);',
  "type === '0' || type === '\\0' || type === '5'",
  'archive must contain exactly one package/package.json',
  "assert.equal(packageJson.name, '@gnolith/workshop');",
  'assert.equal(packageJson.version, expectedVersion);',
  "await appendFile(process.env.GITHUB_OUTPUT, `archive=${archive}\\n`, 'utf8');",
  '- name: Check immutable npm registry state',
  "Trusts npm's verified attestation endpoint over TLS and validates DSSE identity/subject",
  'this job does not perform local Sigstore bundle cryptographic verification.',
  'id: registry-state',
  'EXPECTED_TAG_COMMIT: ${{ needs.build-and-verify.outputs.tag_commit }}',
  "const packageName = '@gnolith/workshop';",
  'if (metadataResponse.status === 404)',
  "await appendFile(process.env.GITHUB_OUTPUT, 'exists=false\\n', 'utf8');",
  "assert.equal(sha256, process.env.EXPECTED_SHA256, 'published registry tarball digest mismatch');",
  "assert.equal(metadata.dist.shasum, shasum, 'registry shasum mismatch');",
  "assert.equal(metadata.dist.integrity, integrity, 'registry integrity mismatch');",
  'metadata.dist.attestations?.provenance?.predicateType,',
  "assert.equal(provenances?.length, 1, 'expected exactly one SLSA provenance attestation');",
  "assert.equal(provenance.bundle?.dsseEnvelope?.payloadType, 'application/vnd.in-toto+json');",
  "assert.ok(provenance.bundle.dsseEnvelope.signatures?.length > 0, 'SLSA provenance signature missing');",
  'const expectedRef = `refs/tags/v${version}`;',
  "assert.equal(statement._type, 'https://in-toto.io/Statement/v1');",
  "'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'",
  "repository: 'https://github.com/gnolith/workshop'",
  "path: '.github/workflows/release.yml'",
  'uri: `git+https://github.com/gnolith/workshop@${expectedRef}`',
  'digest: { gitCommit: process.env.EXPECTED_TAG_COMMIT }',
  'registry provenance annotated-tag commit mismatch',
  "await appendFile(process.env.GITHUB_OUTPUT, 'exists=true\\n', 'utf8');",
  '- name: Publish verified package',
  "if: steps.registry-state.outputs.exists == 'false'",
  'run: npm publish "${{ steps.release-boundary.outputs.archive }}" --ignore-scripts --access public --provenance',
]);
assert.doesNotMatch(
  publish,
  /contents:|github\.token|GH_TOKEN|secrets\.|NPM_BOOTSTRAP_TOKEN|NODE_AUTH_TOKEN|actions\/checkout@|npm ci|npm run|\.\/scripts\/|node_modules|\b(?:bash|sh|python|ruby|perl|pwsh|powershell)\b/u,
);
assert.equal(
  count(publish, /^\s+(?:- )?uses:/gmu),
  2,
  'publish must use exactly setup-node and download-artifact',
);
assert.equal(
  count(publish, /^        run:/gmu),
  3,
  'publish must run only boundary validation, registry validation, and npm publish',
);
assert.equal(
  count(publish, /^      - name:/gmu),
  4,
  'publish must have exactly four named steps',
);
assert.match(
  publish,
  /- name: Publish verified package\n        if: steps\.registry-state\.outputs\.exists == 'false'\n        run: npm publish "\$\{\{ steps\.release-boundary\.outputs\.archive \}\}" --ignore-scripts --access public --provenance\n?$/u,
);

ordered(evidence, [
  'needs: [build-and-verify, publish]',
  'permissions:\n      contents: write',
  '- name: Wait for exact npm registry provenance',
  'this job does not perform local Sigstore bundle cryptographic verification.',
  'EXPECTED_TAG_COMMIT: ${{ needs.build-and-verify.outputs.tag_commit }}',
  'for (let attempt = 1; attempt <= 12; attempt += 1)',
  'await delay(5_000);',
  "assert.equal(sha256, process.env.EXPECTED_SHA256, 'published registry tarball digest mismatch');",
  "assert.equal(metadata.dist.shasum, shasum, 'registry shasum mismatch');",
  "assert.equal(metadata.dist.integrity, integrity, 'registry integrity mismatch');",
  'const expectedRef = `refs/tags/v${version}`;',
  "repository: 'https://github.com/gnolith/workshop'",
  "path: '.github/workflows/release.yml'",
  'uri: `git+https://github.com/gnolith/workshop@${expectedRef}`',
  'digest: { gitCommit: process.env.EXPECTED_TAG_COMMIT }',
  'registry provenance annotated-tag commit mismatch',
  '- name: Download exact verified provenance evidence',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
  "name: release-evidence-${{ github.ref_name }}-${{ needs['build-and-verify'].outputs.package_sha256 }}",
  '- name: Revalidate provenance evidence',
  "EXPECTED_TAG_COMMIT: ${{ needs['build-and-verify'].outputs.tag_commit }}",
  'provenance evidence contains an unexpected file',
  'stat.isFile() && !stat.isSymbolicLink()',
  "assert.equal(provenance.package.name, '@gnolith/workshop');",
  'assert.equal(provenance.package.version, version);',
  'assert.equal(provenance.source.dirty, false);',
  'assert.equal(provenance.source.commit, process.env.EXPECTED_TAG_COMMIT);',
  'assert.equal(provenance.artifact.sha256, process.env.EXPECTED_SHA256);',
  '- name: Create immutable GitHub Release last',
  'GH_TOKEN: ${{ github.token }}',
  'gh release create "$RELEASE_TAG" "$PROVENANCE_PATH" "$SCHEMA_PATH"',
  '--verify-tag',
]);
assert.doesNotMatch(
  evidence,
  /environment: npm|NPM_BOOTSTRAP_TOKEN|NODE_AUTH_TOKEN|actions\/checkout@|npm (?:ci|run|publish)/u,
);
assert.equal(count(evidence, /GH_TOKEN: \$\{\{ github\.token \}\}/gu), 1);
assert.doesNotMatch(evidence, /--clobber/u);
assert.doesNotMatch(evidence, /gh release upload/u);

const recoveryMutations = [
  [
    'digest anchor removal',
    'EXPECTED_SHA256: ${{ needs.build-and-verify.outputs.package_sha256 }}',
  ],
  ['short artifact retention', 'retention-days: 30'],
  [
    'already-published skip removal',
    "if: steps.registry-state.outputs.exists == 'false'",
  ],
  [
    'registry mismatch acceptance',
    'published registry tarball digest mismatch',
  ],
  [
    'preexisting release refusal removal',
    "throw new Error('GitHub Release already exists; refusing npm publication');",
  ],
  ['Release absence proof removal', 'if (response.status === 404)'],
  ['Release API timeout removal', 'signal: AbortSignal.timeout(30_000)'],
  [
    'immutable release creation removal',
    'gh release create "$RELEASE_TAG" "$PROVENANCE_PATH" "$SCHEMA_PATH"',
  ],
  ['annotated release verification removal', '--verify-tag'],
  [
    'source repository binding removal',
    "repository: 'https://github.com/gnolith/workshop'",
  ],
  ['workflow path binding removal', "path: '.github/workflows/release.yml'"],
  ['tag ref binding removal', 'const expectedRef = `refs/tags/v${version}`;'],
  [
    'annotated commit binding removal',
    'digest: { gitCommit: process.env.EXPECTED_TAG_COMMIT }',
  ],
];
for (const [label, protectedFragment] of recoveryMutations) {
  const mutated = workflow.replace(protectedFragment, '');
  assert.notEqual(
    mutated,
    workflow,
    `${label} test fixture did not mutate workflow`,
  );
  assert.notEqual(
    createHash('sha256').update(mutated).digest('hex'),
    expectedWorkflowSha256,
    `${label} mutation bypassed canonical guard`,
  );
}
console.log('release workflow credential boundary verified');

function count(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function countLiteral(value, fragment) {
  let matches = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(fragment, cursor)) >= 0) {
    matches += 1;
    cursor += fragment.length;
  }
  return matches;
}

function job(startName, endName) {
  const start = workflow.indexOf(`\n  ${startName}:\n`);
  const end = workflow.indexOf(`\n  ${endName}:\n`, start + 1);
  assert.ok(start >= 0, `missing ${startName} job`);
  assert.ok(end > start, `missing ${endName} job after ${startName}`);
  return workflow.slice(start, end);
}

function ordered(value, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = value.indexOf(fragment, cursor);
    assert.ok(
      next >= cursor,
      `missing or reordered release boundary fragment: ${fragment}`,
    );
    cursor = next + fragment.length;
  }
}

function tailJob(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing ${name} job`);
  return workflow.slice(start);
}
