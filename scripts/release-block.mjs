import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageName = '@gnolith/taproot';
const version = '0.4.0';
const predicateType = 'https://slsa.dev/provenance/v1';
const sourceCommit = '819fe054ebb867e1ca92518bfd3b1aa6c5aa277d';
const exactIntegrity =
  'sha512-yYxbrUNnu74zBaxHoywGlgeG2LFz4HMzi2RLcsq83/JVEIkwbWvWZ8tuLpxFYxTAgTXG1/FHddgEJStRupe54A==';

export async function verifyTaprootRelease({
  fetchImpl = globalThis.fetch,
  verifyPackage = verifyInstalledPackageProvenance,
} = {}) {
  await verifyPackage();

  const registryUrl = new URL(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`,
  );
  const metadataResponse = await fetchImpl(registryUrl, { redirect: 'error' });
  assert.ok(
    metadataResponse.ok,
    `${packageName} ${version} is not public on npm (${metadataResponse.status})`,
  );
  const metadata = await metadataResponse.json();
  assert.equal(metadata.name, packageName);
  assert.equal(metadata.version, version);
  assert.equal(metadata.dist?.integrity, exactIntegrity);
  const integrityBytes = Buffer.from(
    metadata.dist.integrity.slice('sha512-'.length),
    'base64',
  );
  assert.equal(integrityBytes.length, 64, 'npm integrity must contain SHA-512');
  const sha512 = integrityBytes.toString('hex');
  assert.equal(
    metadata.dist?.attestations?.provenance?.predicateType,
    predicateType,
  );

  const attestationUrl = new URL(metadata.dist.attestations.url);
  assert.equal(attestationUrl.protocol, 'https:');
  assert.equal(attestationUrl.hostname, 'registry.npmjs.org');
  const attestationResponse = await fetchImpl(attestationUrl, {
    redirect: 'error',
  });
  assert.ok(
    attestationResponse.ok,
    `${packageName} provenance is unavailable (${attestationResponse.status})`,
  );
  const attestationDocument = await attestationResponse.json();
  const matchingAttestations = attestationDocument.attestations?.filter(
    (attestation) => attestation.predicateType === predicateType,
  );
  assert.equal(
    matchingAttestations?.length,
    1,
    `${packageName} ${version} must have exactly one SLSA provenance attestation`,
  );
  const provenance = matchingAttestations[0];
  const envelope = provenance.bundle?.dsseEnvelope;
  assert.equal(envelope?.payloadType, 'application/vnd.in-toto+json');
  assert.ok(envelope?.payload, 'SLSA provenance payload is missing');
  assert.ok(
    Array.isArray(envelope.signatures) &&
      envelope.signatures.length > 0 &&
      envelope.signatures.every(
        (signature) =>
          typeof signature?.sig === 'string' && signature.sig.length > 0,
      ),
    'SLSA provenance signature is missing',
  );

  const statement = JSON.parse(
    Buffer.from(envelope.payload, 'base64').toString('utf8'),
  );
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, predicateType);
  assert.deepEqual(statement.subject, [
    {
      name: 'pkg:npm/%40gnolith/taproot@0.4.0',
      digest: { sha512 },
    },
  ]);
  assert.equal(
    statement.predicate?.buildDefinition?.buildType,
    'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
  );
  assert.deepEqual(
    statement.predicate?.buildDefinition?.externalParameters?.workflow,
    {
      ref: 'refs/tags/v0.4.0',
      repository: 'https://github.com/gnolith/taproot',
      path: '.github/workflows/release.yml',
    },
  );
  assert.deepEqual(statement.predicate?.buildDefinition?.resolvedDependencies, [
    {
      uri: 'git+https://github.com/gnolith/taproot@refs/tags/v0.4.0',
      digest: { gitCommit: sourceCommit },
    },
  ]);

  return { packageName, version, sourceCommit };
}

async function verifyInstalledPackageProvenance() {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'npm provenance verification must run through npm');
  const npmEnvironment = {
    ...process.env,
    npm_config_dry_run: 'false',
  };
  const directory = mkdtempSync(join(tmpdir(), 'workshop-taproot-provenance-'));
  try {
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        private: true,
        dependencies: { [packageName]: version },
      })}\n`,
      'utf8',
    );
    execFileSync(
      process.execPath,
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
      ],
      { cwd: directory, env: npmEnvironment, stdio: 'pipe' },
    );
    const installed = JSON.parse(
      readFileSync(
        join(directory, 'node_modules', '@gnolith', 'taproot', 'package.json'),
        'utf8',
      ),
    );
    assert.equal(installed.name, packageName);
    assert.equal(installed.version, version);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [npmCli, 'audit', 'signatures', '--json'],
        {
          cwd: directory,
          encoding: 'utf8',
          env: npmEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    assert.deepEqual(
      result.invalid,
      [],
      'npm found an invalid package signature',
    );
    assert.deepEqual(
      result.missing,
      [],
      'npm found missing package provenance',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const verified = await verifyTaprootRelease();
  console.log(
    `${verified.packageName} ${verified.version} public npm provenance verified`,
  );
}
