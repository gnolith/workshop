import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(
  new URL('../workflows/release.yml', import.meta.url),
  'utf8',
);
const prepublish = inlineNodeAfter('Check immutable npm registry state');
const postpublish = inlineNodeAfter(
  'Wait for exact npm registry provenance',
).replace(
  'if (attempt < 12) await delay(5_000);',
  'if (attempt < 12) await delay(0);',
);
const testRoot = await mkdtemp(join(tmpdir(), 'workshop-release-identity-'));

try {
  for (const validator of [prepublish, postpublish]) {
    run(validator, {}, true);
    run(
      validator,
      { repository: 'https://github.com/attacker/workshop' },
      false,
    );
    run(validator, { path: '.github/workflows/other.yml' }, false);
    run(validator, { ref: 'refs/tags/v9.8.6' }, false);
    run(validator, { commit: 'b'.repeat(40) }, false);
    run(validator, { subjectSha512: 'c'.repeat(128) }, false);
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log('release registry identity failure/recovery tests passed');

function fixturePrelude(overrides) {
  const repository =
    overrides.repository ?? 'https://github.com/gnolith/workshop';
  const path = overrides.path ?? '.github/workflows/release.yml';
  const ref = overrides.ref ?? 'refs/tags/v9.8.7';
  const commit = overrides.commit ?? 'a'.repeat(40);
  const subjectDigest = overrides.subjectSha512
    ? JSON.stringify(overrides.subjectSha512)
    : 'fixtureSha512';
  return `
const fixtureBytes = Buffer.from('verified registry identity fixture');
const { createHash: fixtureHash } = await import('node:crypto');
const fixtureSha256 = fixtureHash('sha256').update(fixtureBytes).digest('hex');
const fixtureSha1 = fixtureHash('sha1').update(fixtureBytes).digest('hex');
const fixtureSha512 = fixtureHash('sha512').update(fixtureBytes).digest('hex');
const fixtureIntegrity = \`sha512-\${fixtureHash('sha512').update(fixtureBytes).digest('base64')}\`;
const fixtureStatement = {
  predicateType: 'https://slsa.dev/provenance/v1',
  subject: [{
    name: 'pkg:npm/%40gnolith/workshop@9.8.7',
    digest: { sha512: ${subjectDigest} },
  }],
  predicate: { buildDefinition: {
    externalParameters: { workflow: {
      ref: ${JSON.stringify(ref)},
      repository: ${JSON.stringify(repository)},
      path: ${JSON.stringify(path)},
    } },
    resolvedDependencies: [{
      uri: ${JSON.stringify(`git+https://github.com/gnolith/workshop@${ref}`)},
      digest: { gitCommit: ${JSON.stringify(commit)} },
    }],
  } },
};
const fixtureAttestations = { attestations: [{
  predicateType: 'https://slsa.dev/provenance/v1',
  bundle: { dsseEnvelope: {
    payload: Buffer.from(JSON.stringify(fixtureStatement)).toString('base64'),
  } },
}] };
const fixtureMetadata = {
  name: '@gnolith/workshop',
  version: '9.8.7',
  dist: {
    tarball: 'https://registry.npmjs.org/@gnolith/workshop/-/workshop-9.8.7.tgz',
    shasum: fixtureSha1,
    integrity: fixtureIntegrity,
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2fworkshop@9.8.7',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
  },
};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/-/npm/v1/attestations/'))
    return new Response(JSON.stringify(fixtureAttestations));
  if (url.endsWith('.tgz')) return new Response(fixtureBytes);
  return new Response(JSON.stringify(fixtureMetadata));
};
process.env.EXPECTED_SHA256 = fixtureSha256;
`;
}

function inlineNodeAfter(stepName) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.ok(start >= 0, `missing ${stepName}`);
  const match = workflow
    .slice(start)
    .match(
      /node --input-type=module <<'NODE'\r?\n(?<code>[\s\S]*?)^          NODE$/mu,
    );
  assert.ok(match, `missing inline Node block for ${stepName}`);
  return match.groups.code;
}

function run(validator, overrides, shouldPass) {
  const output = join(testRoot, `output-${randomUUID()}`);
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: fixturePrelude(overrides) + validator,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED_TAG_COMMIT: 'a'.repeat(40),
      GITHUB_OUTPUT: output,
      RELEASE_TAG: 'v9.8.7',
    },
  });
  assert.equal(
    result.status === 0,
    shouldPass,
    `identity case ${JSON.stringify(overrides)} unexpectedly ${result.status === 0 ? 'passed' : `failed: ${result.stderr}`}`,
  );
}
