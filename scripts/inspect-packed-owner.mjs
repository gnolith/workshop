import { pathToFileURL } from 'node:url';

const [adapterPath] = process.argv.slice(2);
if (!adapterPath)
  throw new Error('usage: node scripts/inspect-packed-owner.mjs <adapter>');

const adapter = await import(
  `${pathToFileURL(adapterPath).href}?inspect=${Date.now()}`
);
try {
  process.stdout.write(
    `${JSON.stringify(await adapter.inspectOwnWorkshopState())}\n`,
  );
} finally {
  await adapter.closeFixtureDatabase();
}
