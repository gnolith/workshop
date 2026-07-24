import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { createGnolithMcpServer } from '../dist/mcp/server.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

const mcp = createGnolithMcpServer({
  version: '0.5.0',
  operations: {
    async execute() {
      throw new Error('invalid requests must not dispatch');
    },
  },
  authenticate: async () => ({}),
  maxRequestBytes: MAX_RESPONSE_BYTES,
});
const headers = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};
const malformed = await mcp.handle(
  new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers,
    body: '{',
  }),
);
const payload = await malformed.json();
if (
  malformed.status !== 400 ||
  !malformed.headers.get('content-type')?.startsWith('application/json') ||
  payload?.jsonrpc !== '2.0' ||
  payload?.error?.code !== -32700
) {
  throw new Error(
    `Workshop MCP returned status=${malformed.status}, contentType=${malformed.headers.get('content-type')}, code=${payload?.error?.code}`,
  );
}

const oversized = await mcp.handle(
  new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-length': String(MAX_RESPONSE_BYTES + 1),
    },
    body: Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20),
  }),
);
if (oversized.status !== 413) {
  throw new Error(
    `oversized Workshop MCP request returned ${oversized.status}`,
  );
}

const miniflareRequire = createRequire(import.meta.resolve('miniflare'));
const sharpEntry = miniflareRequire.resolve('sharp');
const { default: sharp } = await import(pathToFileURL(sharpEntry).href);
if (sharp.versions.sharp !== '0.35.3') {
  throw new Error(
    `unexpected Miniflare sharp version: ${sharp.versions.sharp}`,
  );
}

const png = await sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const webp = await sharp(png).webp({ lossless: true }).toBuffer();
const metadata = await sharp(webp).metadata();
if (
  metadata.format !== 'webp' ||
  metadata.width !== 1 ||
  metadata.height !== 1
) {
  throw new Error('Miniflare native sharp PNG-to-WebP conversion failed');
}

console.log(
  `dev security compatibility passed (Workshop MCP, sharp ${sharp.versions.sharp})`,
);
