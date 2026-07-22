import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const require = createRequire(import.meta.url);
const LOOPBACK_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function packageMetadata(entry) {
  let directory = dirname(entry);
  for (;;) {
    try {
      return JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
    } catch (error) {
      const parent = dirname(directory);
      if (parent === directory) {
        throw error;
      }
      directory = parent;
    }
  }
}

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
if (typeof transport.handleRequest !== 'function') {
  throw new Error(
    'MCP StreamableHTTPServerTransport did not construct correctly',
  );
}

const server = createServer((incoming, response) => {
  if (incoming.url === '/oversized') {
    response.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    return;
  }
  void transport.handleRequest(incoming, response).catch((error) => {
    response.destroy(error);
  });
});
server.requestTimeout = LOOPBACK_TIMEOUT_MS;
server.headersTimeout = LOOPBACK_TIMEOUT_MS;
server.keepAliveTimeout = 500;
server.setTimeout(LOOPBACK_TIMEOUT_MS, (socket) => {
  socket.destroy(new Error('MCP compatibility server request timed out'));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('MCP compatibility server did not bind to a TCP port');
  }

  const requestLoopback = (path, body = '') =>
    new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(
          new Error(
            `MCP compatibility request exceeded ${LOOPBACK_TIMEOUT_MS}ms`,
          ),
        );
      }, LOOPBACK_TIMEOUT_MS);
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };

      const outgoing = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
          method: 'POST',
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks = [];
          let responseBytes = 0;
          response.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              const error = new Error(
                `MCP compatibility response exceeded ${MAX_RESPONSE_BYTES} bytes`,
              );
              controller.abort(error);
              response.destroy(error);
              outgoing.destroy(error);
              settle(reject, error);
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            settle(resolve, {
              status: response.statusCode,
              contentType: response.headers['content-type'],
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.once('error', (error) => settle(reject, error));
        },
      );
      outgoing.once('error', (error) => settle(reject, error));
      outgoing.setTimeout(LOOPBACK_TIMEOUT_MS, () => {
        const error = new Error(
          `MCP compatibility socket exceeded ${LOOPBACK_TIMEOUT_MS}ms`,
        );
        outgoing.destroy(error);
        settle(reject, error);
      });
      outgoing.end(body);
    });

  const result = await requestLoopback('/mcp', '{');

  const payload = JSON.parse(result.body);
  if (
    result.status !== 400 ||
    !result.contentType?.startsWith('application/json') ||
    payload?.jsonrpc !== '2.0' ||
    payload?.error?.code !== -32700
  ) {
    throw new Error(
      `MCP Node-to-Web HTTP bridge returned status=${result.status}, contentType=${result.contentType}, code=${payload?.error?.code}`,
    );
  }

  await requestLoopback('/oversized').then(
    () => {
      throw new Error('oversized MCP compatibility response was accepted');
    },
    (error) => {
      if (!String(error.message).includes('exceeded 65536 bytes')) {
        throw error;
      }
    },
  );
} finally {
  try {
    await transport.close();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) =>
        error === undefined || error.code === 'ERR_SERVER_NOT_RUNNING'
          ? resolve()
          : reject(error),
      );
    });
  }
}

const hono = await packageMetadata(require.resolve('@hono/node-server'));
if (hono.name !== '@hono/node-server' || hono.version !== '2.0.11') {
  throw new Error(`unexpected @hono/node-server version: ${hono.version}`);
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
  `dev security compatibility passed (@hono/node-server ${hono.version}, sharp ${sharp.versions.sharp})`,
);
