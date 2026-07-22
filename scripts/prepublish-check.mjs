import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${manifest.version}`;

if (process.argv[2] === '--verify-dry-run') {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'publish dry-run verification must run through npm');
  const result = spawnSync(process.execPath, [npmCli, 'publish', '--dry-run'], {
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, 'untagged npm publish dry run must fail');
  assert.match(
    output,
    /@gnolith\/taproot 0\.3\.0 public npm provenance verified/u,
    'Taproot provenance verification did not complete before publication stopped',
  );
  assert.match(
    output,
    /refs\/tags\/v0\.3\.2|Needed a single revision/u,
    'publication did not stop at the missing Workshop v0.3.2 tag',
  );
  assert.doesNotMatch(
    output,
    /ENOENT.*taproot/iu,
    'publication exited before Taproot verification completed',
  );
  console.log('untagged npm publish dry run reached the Workshop tag boundary');
} else {
  execFileSync(process.execPath, ['scripts/release-block.mjs'], {
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/release-check.mjs', tag], {
    stdio: 'inherit',
  });
}
