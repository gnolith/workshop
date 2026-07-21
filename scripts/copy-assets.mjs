import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../src/ui/styles/workshop.css', import.meta.url),
  new URL('../dist/styles.css', import.meta.url),
);
