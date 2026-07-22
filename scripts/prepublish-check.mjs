import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main() {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const tag = `v${manifest.version}`;
  if (process.argv[2] !== '--verify-dry-run') {
    execFileSync(process.execPath, ['scripts/release-block.mjs'], {
      stdio: 'inherit',
    });
    execFileSync(process.execPath, ['scripts/release-check.mjs', tag], {
      stdio: 'inherit',
    });
    return;
  }
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'publish dry-run verification must run through npm');
  const result = spawnSync(process.execPath, [npmCli, 'publish', '--dry-run'], {
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.match(
    output,
    /@gnolith\/taproot 0\.4\.0 public npm provenance verified/u,
    'Taproot provenance verification did not complete before publication stopped',
  );
  assert.doesNotMatch(
    output,
    /ENOENT.*taproot/iu,
    'publication exited before Taproot verification completed',
  );
  const head = git(['rev-parse', 'HEAD']);
  const tagType = git(['cat-file', '-t', `refs/tags/${tag}`], true);
  const tagCommit = git(['rev-list', '-n', '1', `refs/tags/${tag}`], true);
  const mode = assertPublishDryRunBoundary({
    status: result.status,
    output,
    tag,
    head,
    tagType,
    tagCommit,
  });
  console.log(
    mode === 'tagged'
      ? 'tagged npm publish dry run validated the Workshop artifact'
      : 'untagged npm publish dry run reached the exact missing-tag boundary',
  );
}

export function assertPublishDryRunBoundary({
  status,
  output,
  tag,
  head,
  tagType,
  tagCommit,
}) {
  if (tagType === 'tag' && tagCommit === head) {
    assert.equal(status, 0, 'trusted tagged npm publish dry run failed');
    assert.match(
      output,
      new RegExp(
        `release artifact validated for ${escapeRegExp(tag)} at ${head}`,
        'u',
      ),
      'tagged publication did not validate the exact Workshop artifact',
    );
    return 'tagged';
  }
  assert.equal(
    tagType,
    null,
    `${tag} exists but is not an annotated tag at HEAD`,
  );
  assert.equal(tagCommit, null, `${tag} resolves away from HEAD`);
  assert.notEqual(status, 0, 'untagged npm publish dry run must fail');
  const escapedTag = escapeRegExp(tag);
  assert.match(
    output,
    new RegExp(
      `fatal: (?:ambiguous argument 'refs/tags/${escapedTag}': unknown revision or path not in the working tree\\.|Needed a single revision)`,
      'u',
    ),
    `publication did not stop at the exact missing Workshop ${tag} tag error`,
  );
  assert.doesNotMatch(output, /release artifact validated for/u);
  return 'untagged';
}

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status === 0) return result.stdout.trim();
  if (allowFailure) return null;
  throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
