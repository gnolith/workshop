import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import {
  OPERATION_ROUTE_PREFIX,
  operationCatalog,
  type OperationName,
} from '../generated/operations.js';
import type {
  OperationRuntime,
  WorkshopStatusSnapshot,
} from '../operations.js';
import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type { AuthenticationVerifier } from './auth.js';
import type { VerifiedWaystoneAssets } from './assets.js';
import type { ListenerConfig } from './config.js';
import { validateListenerConfig } from './config.js';
import type { BoundedTriggerController } from './lifecycle.js';
import { createGnolithMcpServer } from '../mcp/server.js';
import {
  assertVerifiedWorkshopProducerBinding,
  type VerifiedWorkshopProducerBinding,
  type WorkshopProducerBindingExpectation,
} from '../producers.js';

export interface CloseableDependency {
  close(): void | Promise<void>;
}

export interface WorkshopHttpServiceOptions {
  version: string;
  listener: ListenerConfig;
  authentication: AuthenticationVerifier;
  operations: OperationRuntime;
  producerBinding: {
    binding: VerifiedWorkshopProducerBinding;
    expectation: WorkshopProducerBindingExpectation;
  };
  preflight(signal: AbortSignal): Promise<WorkshopStatusSnapshot>;
  corsOrigins?: readonly string[];
  assets?: VerifiedWaystoneAssets;
  trigger?: BoundedTriggerController;
  dependencies?: readonly CloseableDependency[];
  shutdownTimeoutMs?: number;
  logger?: {
    info(event: Readonly<Record<string, unknown>>): void;
    error(event: Readonly<Record<string, unknown>>): void;
  };
}

export interface WorkshopHttpService {
  readonly listener: ListenerConfig;
  readonly fetch: (request: Request) => Promise<Response>;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createWorkshopHttpService(
  options: WorkshopHttpServiceOptions,
): WorkshopHttpService {
  const listener = validateListenerConfig(options.listener);
  assertVerifiedWorkshopProducerBinding(
    options.producerBinding.binding,
    options.producerBinding.expectation,
  );
  const origins = new Set(options.corsOrigins ?? []);
  const mcp = createGnolithMcpServer({
    version: options.version,
    operations: options.operations,
    authenticate: (request) => options.authentication.authenticate(request),
    allowedOrigins: [...origins],
    challenge: options.authentication.challenge,
  });
  let server: Server | undefined;
  let started = false;
  let draining = false;
  let active = 0;
  const drained = new Set<() => void>();
  const fetch = async (request: Request): Promise<Response> => {
    if (draining && request.method !== 'GET')
      return errorResponse(
        new WorkshopError('dependency_unavailable', 'Service is draining', 503),
        request,
        origins,
      );
    active += 1;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health/live' && request.method === 'GET')
        return Response.json(
          { status: 'live' },
          {
            headers: {
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          },
        );
      if (
        url.pathname === '/.well-known/oauth-protected-resource/mcp' &&
        request.method === 'GET'
      ) {
        const metadata = options.authentication.protectedResourceMetadata();
        return metadata
          ? Response.json(metadata, {
              headers: { 'cache-control': 'public, max-age=300' },
            })
          : new Response('Not found', { status: 404 });
      }
      if (url.pathname === '/mcp') return mcp.handle(request);
      if (
        url.pathname.startsWith(`${OPERATION_ROUTE_PREFIX}/`) &&
        request.method === 'OPTIONS'
      ) {
        const originFailure = validateOrigin(request, origins);
        if (originFailure) return originFailure;
        const headers = responseHeaders(request, origins);
        headers.set('access-control-allow-methods', 'POST, OPTIONS');
        headers.set(
          'access-control-allow-headers',
          'authorization, content-type, x-request-id',
        );
        headers.set('access-control-max-age', '600');
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === '/health/ready' && request.method === 'GET') {
        try {
          const principal = await options.authentication.authenticate(request);
          const value = await options.operations.call(
            'gnolith_status',
            {},
            {
              principal,
              requestId: requestId(request),
              signal: request.signal,
            },
          );
          const ready = readinessFromStatus(value);
          return Response.json(value, {
            status: ready ? 200 : 503,
            headers: responseHeaders(request, origins),
          });
        } catch (error) {
          return errorResponse(error, request, origins);
        }
      }
      if (
        url.pathname.startsWith(`${OPERATION_ROUTE_PREFIX}/`) &&
        request.method === 'POST'
      )
        return operationResponse(request, options, origins);
      const assetResponse = await options.assets?.serve(url.pathname);
      if (assetResponse) return assetResponse;
      return new Response('Not found', { status: 404 });
    } finally {
      active -= 1;
      if (active === 0) {
        for (const resolve of drained) resolve();
        drained.clear();
      }
    }
  };
  return {
    listener,
    fetch,
    async start() {
      if (started)
        throw new WorkshopError('conflict', 'Service is already started', 409);
      const preflight = await options.preflight(new AbortController().signal);
      if (!startupReady(preflight))
        throw new WorkshopError(
          'dependency_unavailable',
          'Required migrations, authorization, canonical data, or producers are not ready; run the explicit migration/bootstrap workflow',
          503,
        );
      server = createServer((incoming, outgoing) => {
        void handleNodeExchange(incoming, outgoing, listener, fetch);
      });
      server.requestTimeout = 35_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(listener.port, listener.host, () => {
          server!.off('error', reject);
          resolve();
        });
      });
      started = true;
      options.trigger?.start();
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : listener.port;
      options.logger?.info({
        event: 'service.started',
        profile: listener.profile,
        host: listener.host,
        port,
      });
      return { host: listener.host, port };
    },
    async stop() {
      if (!started || !server) return;
      draining = true;
      const closingServer = server;
      const closed = new Promise<void>((resolve, reject) => {
        closingServer.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve(),
        );
      });
      server.closeIdleConnections();
      const timeoutMs = options.shutdownTimeoutMs ?? 30_000;
      const abort = new AbortController();
      const timeout = setTimeout(
        () => abort.abort(new Error('shutdown timeout')),
        timeoutMs,
      );
      try {
        await Promise.all([
          waitForDrain(() => active, drained, abort.signal),
          ...(options.trigger ? [options.trigger.stop(abort.signal)] : []),
        ]);
        for (const dependency of options.dependencies ?? [])
          await dependency.close();
        await Promise.race([closed, aborted(abort.signal)]);
      } finally {
        clearTimeout(timeout);
        started = false;
        server = undefined;
        options.logger?.info({ event: 'service.stopped' });
      }
    },
  };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

async function operationResponse(
  request: Request,
  options: WorkshopHttpServiceOptions,
  origins: ReadonlySet<string>,
): Promise<Response> {
  const originFailure = validateOrigin(request, origins);
  if (originFailure) return originFailure;
  try {
    const principal = await options.authentication.authenticate(request);
    const name = new URL(request.url).pathname.slice(
      OPERATION_ROUTE_PREFIX.length + 1,
    );
    if (!operationCatalog.some((operation) => operation.name === name))
      return errorResponse(
        new WorkshopError('not_found', 'Operation not found', 404),
        request,
        origins,
      );
    const input = await boundedJson(request, 1024 * 1024);
    const value = await options.operations.call(name as OperationName, input, {
      principal,
      requestId: requestId(request),
      signal: request.signal,
    });
    return Response.json(value, {
      headers: responseHeaders(request, origins),
    });
  } catch (error) {
    return errorResponse(error, request, origins);
  }
}

function startupReady(status: WorkshopStatusSnapshot): boolean {
  return (
    status.migrations.ready &&
    status.compatibility.diamond &&
    status.compatibility.taproot &&
    status.canonicalReady &&
    status.authorizationReady &&
    status.lexicalReady &&
    status.producers.ready &&
    status.blobReady
  );
}

function readinessFromStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  const migration = status.migrationReadiness as
    Record<string, unknown> | undefined;
  const producers = status.producers as Record<string, unknown> | undefined;
  return (
    migration?.ready === true &&
    status.canonicalReady === true &&
    status.authorizationReady === true &&
    status.lexicalReady === true &&
    producers?.ready === true &&
    status.blobReady === true
  );
}

function responseHeaders(
  request: Request,
  origins: ReadonlySet<string>,
): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  const origin = request.headers.get('origin');
  if (
    origin &&
    (origin === new URL(request.url).origin || origins.has(origin))
  ) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return headers;
}

function validateOrigin(
  request: Request,
  origins: ReadonlySet<string>,
): Response | null {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && !origins.has(origin))
    return Response.json(
      { error: { code: 'forbidden', message: 'Origin is not allowed' } },
      { status: 403 },
    );
  return null;
}

function errorResponse(
  error: unknown,
  request: Request,
  origins: ReadonlySet<string>,
): Response {
  const normalized = normalizeWorkshopError(error);
  const message =
    normalized.code === 'internal_error'
      ? 'Workshop operation failed'
      : normalized.message;
  return Response.json(
    {
      error: {
        code: normalized.code,
        message,
        requestId: requestId(request),
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    },
    {
      status: normalized.status,
      headers: responseHeaders(request, origins),
    },
  );
}

async function boundedJson(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json'
  )
    throw new WorkshopError(
      'bad_request',
      'Request requires application/json',
      415,
    );
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new WorkshopError('limit_exceeded', 'Request body is too large', 413);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new WorkshopError('bad_request', 'Invalid JSON object body', 400);
  }
}

function requestId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  return supplied &&
    supplied.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

async function waitForDrain(
  active: () => number,
  drained: Set<() => void>,
  signal: AbortSignal,
): Promise<void> {
  if (active() === 0) return;
  await new Promise<void>((resolve, reject) => {
    const completed = () => {
      signal.removeEventListener('abort', cancelled);
      resolve();
    };
    const cancelled = () => {
      drained.delete(completed);
      reject(signal.reason);
    };
    drained.add(completed);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

function nodeRequest(
  incoming: import('node:http').IncomingMessage,
  listener: ListenerConfig,
): Request {
  const origin = `http://${formatHost(listener.host)}:${listener.port}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? 'GET';
  return new Request(new URL(incoming.url ?? '/', origin), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : {
          body: Readable.toWeb(incoming),
          duplex: 'half',
        }),
  } as RequestInit);
}

async function writeNodeResponse(
  response: Response,
  outgoing: import('node:http').ServerResponse,
): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (!response.body) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as never);
    stream.once('error', reject);
    outgoing.once('error', reject);
    outgoing.once('finish', resolve);
    stream.pipe(outgoing);
  });
}

async function handleNodeExchange(
  incoming: import('node:http').IncomingMessage,
  outgoing: import('node:http').ServerResponse,
  listener: ListenerConfig,
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const response = await fetchHandler(nodeRequest(incoming, listener));
    await writeNodeResponse(response, outgoing);
  } catch (error) {
    const normalized = normalizeWorkshopError(error);
    outgoing.statusCode = normalized.status;
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end(
      JSON.stringify({
        error: {
          code: normalized.code,
          message:
            normalized.code === 'internal_error'
              ? 'Workshop operation failed'
              : normalized.message,
        },
      }),
    );
  }
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
