import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const npmCli =
  process.env.npm_execpath ??
  (process.platform === 'win32'
    ? join(
        dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      )
    : resolve(
        dirname(process.execPath),
        '..',
        'lib',
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      ));
const stagingRoot = mkdtempSync(join(tmpdir(), 'workshop-peer-artifacts-'));
const artifactRoot = resolve(process.env.WORKSHOP_PEER_ARTIFACT_ROOT ?? '..');
const peerEvidence = JSON.parse(
  readFileSync(resolve('docs', 'peer-artifacts-v1.json'), 'utf8'),
);
assert.equal(peerEvidence.format, 'gnolith-workshop-peer-artifacts-v1');
assert.equal(peerEvidence.version, 1);
const peers = peerEvidence.peers;

try {
  for (const peer of peers) materialize(peer);
} finally {
  const resolvedStaging = resolve(stagingRoot);
  const resolvedTemp = resolve(tmpdir());
  assert.ok(
    resolvedStaging.startsWith(`${resolvedTemp}\\`) ||
      resolvedStaging.startsWith(`${resolvedTemp}/`),
    'Peer staging directory escaped the operating-system temp directory',
  );
  assert.match(
    resolvedStaging.split(/[\\/]/u).at(-1) ?? '',
    /^workshop-peer-artifacts-/u,
  );
  rmSync(resolvedStaging, { recursive: true, force: true });
}

function materialize(peer) {
  const destination = join(
    artifactRoot,
    peer.destinationDirectory ?? peer.name,
    peer.filename,
  );
  const source = join(stagingRoot, peer.name);
  if (existsSync(destination)) {
    verifyArtifact(destination, peer);
    mkdirSync(source, { recursive: true });
    copyFileSync(destination, join(source, peer.filename));
    console.log(`verified existing ${peer.name} artifact`);
    return;
  }

  run('git', [
    'clone',
    '--quiet',
    '--filter=blob:none',
    peer.repository,
    source,
  ]);
  run('git', ['-C', source, 'checkout', '--quiet', '--detach', peer.commit]);
  const actualCommit = capture('git', ['-C', source, 'rev-parse', 'HEAD']);
  assert.equal(actualCommit, peer.commit, `${peer.name} source commit differs`);
  run(
    process.execPath,
    [npmCli, 'ci', '--ignore-scripts=false', '--no-audit', '--no-fund'],
    source,
  );
  run(
    process.execPath,
    [npmCli, 'pack', '--pack-destination', source, '--silent'],
    source,
  );

  const artifact = join(source, peer.filename);
  verifyArtifact(artifact, peer);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(artifact, destination);
  verifyArtifact(destination, peer);
  console.log(`materialized ${peer.name} ${peer.commit} ${peer.sha256}`);
}

function verifyArtifact(path, peer) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    `${peer.name} artifact must be regular`,
  );
  const bytes = readFileSync(path);
  assert.equal(bytes.length, peer.bytes, `${peer.name} artifact size differs`);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    peer.sha256,
    `${peer.name} artifact SHA-256 differs`,
  );
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    peer.integrity,
    `${peer.name} artifact integrity differs`,
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  });
  assert.equal(result.error, undefined, `${command} could not start`);
  assert.equal(
    result.signal,
    null,
    `${command} was terminated by ${result.signal}`,
  );
  assert.equal(result.status, 0, `${command} exited ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.error, undefined, `${command} could not start`);
  assert.equal(
    result.signal,
    null,
    `${command} was terminated by ${result.signal}`,
  );
  assert.equal(
    result.status,
    0,
    `${command} exited ${result.status}: ${result.stderr}`,
  );
  return result.stdout.trim();
}
