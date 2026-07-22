import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error('npm_execpath is required for the full dependency audit');
}

const result = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
  encoding: 'utf8',
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error(`npm audit did not return JSON: ${result.stderr.trim()}`);
}

const vulnerabilities = report.metadata?.vulnerabilities;
if (vulnerabilities?.total !== 0 || result.status !== 0) {
  throw new Error(
    `full dependency audit found ${vulnerabilities?.total ?? 'unknown'} vulnerabilities`,
  );
}

console.log('full dependency audit passed (0 vulnerabilities)');
