import {
  operationCatalog,
  type OperationName,
} from '../generated/operations.js';
import type { OperationRuntime } from '../operations.js';
import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type { AuthenticatedPrincipal } from '../protocol.js';

export const GNOLITH_MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOLS = new Set([
  GNOLITH_MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
]);
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

type RequestId = string | number;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: RequestId | null;
  method?: string;
  params?: unknown;
}

export interface GnolithMcpServerOptions {
  version: string;
  operations: OperationRuntime;
  authenticate(request: Request): Promise<AuthenticatedPrincipal>;
  allowedOrigins?: readonly string[];
  maxRequestBytes?: number;
  challenge?: string;
}

export interface GnolithMcpServer {
  readonly tools: typeof operationCatalog;
  handle(request: Request): Promise<Response>;
}

export function createGnolithMcpServer(
  options: GnolithMcpServerOptions,
): GnolithMcpServer {
  const origins = new Set(options.allowedOrigins ?? []);
  const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  return {
    tools: operationCatalog,
    async handle(request) {
      if (request.method === 'GET') return methodNotAllowed('POST, OPTIONS');
      if (request.method === 'OPTIONS') return preflight(request, origins);
      if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      const originFailure = validateOrigin(request, origins);
      if (originFailure) return originFailure;
      const contentType = request.headers.get('content-type')?.split(';', 1)[0];
      if (contentType !== 'application/json')
        return httpError(415, 'MCP requests require application/json');
      const accept = request.headers.get('accept') ?? '';
      if (
        !accept.includes('application/json') ||
        !accept.includes('text/event-stream')
      )
        return httpError(
          406,
          'MCP requests must accept application/json and text/event-stream',
        );

      let principal: AuthenticatedPrincipal;
      try {
        principal = await options.authenticate(request);
      } catch {
        return unauthenticated(options.challenge);
      }

      let message: JsonRpcMessage;
      try {
        message = await readMessage(request, maxBytes);
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        return rpcResponse(
          rpcError(null, -32700, normalized.message),
          normalized.status,
          request,
          origins,
        );
      }
      if (
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        Array.isArray(message)
      )
        return rpcResponse(
          rpcError(message.id ?? null, -32600, 'Invalid JSON-RPC request'),
          400,
          request,
          origins,
        );
      const protocol =
        request.headers.get('mcp-protocol-version') ?? '2025-03-26';
      if (
        message.method !== 'initialize' &&
        message.method !== 'notifications/initialized' &&
        !SUPPORTED_PROTOCOLS.has(protocol)
      )
        return httpError(400, 'Unsupported MCP protocol version');

      if (message.id === undefined || message.id === null) {
        return new Response(null, {
          status: 202,
          headers: responseHeaders(request, origins),
        });
      }

      try {
        const result = await dispatch(message, request, principal, options);
        return rpcResponse(
          { jsonrpc: '2.0', id: message.id, result },
          200,
          request,
          origins,
        );
      } catch (error) {
        if (error instanceof ProtocolError)
          return rpcResponse(
            rpcError(message.id, error.rpcCode, error.message),
            200,
            request,
            origins,
          );
        const normalized = normalizeWorkshopError(error);
        const operationFailure =
          normalized.code === 'unauthenticated' ||
          normalized.code === 'forbidden'
            ? { code: -32001, message: normalized.message }
            : {
                code: -32603,
                message:
                  normalized.code === 'internal_error'
                    ? 'Workshop operation failed'
                    : normalized.message,
                data: normalized.toJSON(),
              };
        return rpcResponse(
          rpcError(
            message.id,
            operationFailure.code,
            operationFailure.message,
            'data' in operationFailure ? operationFailure.data : undefined,
          ),
          200,
          request,
          origins,
        );
      }
    },
  };
}

async function dispatch(
  message: JsonRpcMessage,
  request: Request,
  principal: AuthenticatedPrincipal,
  options: GnolithMcpServerOptions,
): Promise<unknown> {
  switch (message.method) {
    case 'initialize': {
      const params = asObject(message.params);
      const requested =
        typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : GNOLITH_MCP_PROTOCOL_VERSION;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested)
          ? requested
          : GNOLITH_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gnolith', version: options.version },
        instructions:
          'Gnolith exposes one authenticated operation catalog. Search before creating; use exact revisions and task lease tokens for mutations.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: operationCatalog.map((definition) => ({
          name: definition.name,
          title: title(definition.name),
          description: `${definition.name} v${definition.version}`,
          inputSchema: definition.inputSchema,
          annotations: {
            readOnlyHint: definition.annotations.readOnly,
            destructiveHint: definition.annotations.destructive,
            idempotentHint: definition.annotations.idempotent,
          },
        })),
      };
    case 'tools/call': {
      const params = asObject(message.params);
      const name = typeof params.name === 'string' ? params.name : '';
      if (!operationCatalog.some((operation) => operation.name === name))
        throw new ProtocolError(-32602, 'Unknown operation');
      const input =
        params.arguments === undefined ? {} : asObject(params.arguments);
      const requestId =
        boundedRequestId(request.headers.get('x-request-id')) ??
        crypto.randomUUID();
      const value = await options.operations.call(
        name as OperationName,
        input,
        {
          principal,
          requestId,
          signal: request.signal,
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: toStructured(value),
        isError: false,
      };
    }
    default:
      throw new ProtocolError(-32601, 'Method not supported');
  }
}

async function readMessage(
  request: Request,
  maxBytes: number,
): Promise<JsonRpcMessage> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new WorkshopError('limit_exceeded', 'MCP request is too large', 413);
  if (!request.body)
    throw new WorkshopError('bad_request', 'Missing MCP request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WorkshopError(
        'limit_exceeded',
        'MCP request is too large',
        413,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (Array.isArray(parsed))
      throw new WorkshopError(
        'bad_request',
        'Batched JSON-RPC is not supported',
      );
    return parsed as JsonRpcMessage;
  } catch (error) {
    if (error instanceof WorkshopError) throw error;
    throw new WorkshopError('bad_request', 'Invalid JSON request body');
  }
}

function validateOrigin(
  request: Request,
  origins: ReadonlySet<string>,
): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (origin !== new URL(request.url).origin && !origins.has(origin))
    return httpError(403, 'Origin is not allowed');
  return null;
}

function preflight(request: Request, origins: ReadonlySet<string>): Response {
  const failure = validateOrigin(request, origins);
  if (failure) return failure;
  const headers = responseHeaders(request, origins);
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set(
    'access-control-allow-headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Request-Id',
  );
  return new Response(null, { status: 204, headers });
}

function responseHeaders(
  request: Request,
  origins: ReadonlySet<string>,
): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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

function rpcResponse(
  body: unknown,
  status: number,
  request: Request,
  origins: ReadonlySet<string>,
): Response {
  const headers = responseHeaders(request, origins);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function unauthenticated(challenge = 'Bearer'): Response {
  return Response.json(
    { error: { code: 'unauthenticated', message: 'Authentication required' } },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': challenge,
      },
    },
  );
}

function httpError(status: number, message: string): Response {
  return Response.json(
    { error: { code: 'bad_request', message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', {
    status: 405,
    headers: { allow },
  });
}

function rpcError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, 'Expected an object');
  return value as Record<string, unknown>;
}

function toStructured(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function boundedRequestId(value: string | null): string | null {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))
    return null;
  return value;
}

function title(name: string): string {
  return name
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

class ProtocolError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}
