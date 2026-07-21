import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const provenanceModule = pathToFileURL(
  resolve('scripts/artifact-provenance.mjs'),
).href;

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('release version history authority', () => {
  it('ignores divergent PR refs while rejecting reuse on authoritative history', () => {
    const fixture = repository();
    writeJson(join(fixture, 'package.json'), {
      name: '@gnolith/workshop',
      version: '0.2.3',
    });
    writeJson(join(fixture, 'package-lock.json'), { lockfileVersion: 3 });
    git(fixture, ['add', 'package.json', 'package-lock.json']);
    git(fixture, ['commit', '-m', 'release 0.2.3']);
    git(fixture, ['tag', '-a', 'v0.2.3', '-m', 'v0.2.3']);

    git(fixture, ['switch', '-c', 'dependabot/npm-and-yarn/example']);
    writeJson(join(fixture, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: { divergent: true },
    });
    git(fixture, ['add', 'package-lock.json']);
    git(fixture, ['commit', '-m', 'divergent dependency update']);

    git(fixture, ['switch', '--detach', 'v0.2.3']);
    const releaseRecovery = check(fixture, {
      ref: 'refs/tags/v0.2.3',
      requireHead: true,
    });
    expect(releaseRecovery.status).toBe(0);

    git(fixture, ['switch', '-c', 'agent/reuse-version']);
    writeJson(join(fixture, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: { authoritativeReuse: true },
    });
    git(fixture, ['add', 'package-lock.json']);
    git(fixture, ['commit', '-m', 'reuse version with changed inputs']);
    const reuse = check(fixture, { ref: 'HEAD', requireHead: true });
    expect(reuse.status).not.toBe(0);
    expect(reuse.stderr).toContain(
      'on authoritative history HEAD with different artifact inputs; bump the version',
    );
  }, 30_000);
});

function check(cwd: string, options: { ref: string; requireHead: boolean }) {
  const source = `
    import { readFileSync } from 'node:fs';
    import { assertVersionIsUnambiguous } from ${JSON.stringify(provenanceModule)};
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    assertVersionIsUnambiguous(manifest, ${JSON.stringify(options)});
  `;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd,
      encoding: 'utf8',
    },
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'workshop-release-history-'));
  fixtures.push(fixture);
  git(fixture, ['init', '--initial-branch=main']);
  git(fixture, ['config', 'user.name', 'Workshop Test']);
  git(fixture, ['config', 'user.email', 'workshop@example.invalid']);
  return fixture;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
