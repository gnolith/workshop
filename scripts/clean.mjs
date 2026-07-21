import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const root = resolve('.');
for (const name of ['dist', 'coverage', '.wrangler']) {
  const target = resolve(root, name);
  if (dirname(target) !== root || basename(target) !== name) {
    throw new Error(`Unexpected clean target: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
