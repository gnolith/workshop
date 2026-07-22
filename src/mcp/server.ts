import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type { WorkshopPrincipal } from '../protocol.js';
import type { WorkshopRuntime } from '../server/context.js';
import { resolveLimits } from '../server/limits.js';
import { observeSafely } from '../server/observability.js';
import {
  createWorkshopToolDispatcher,
  type WorkshopDispatchFailure,
  type WorkshopToolDispatcher,
} from './dispatcher.js';
import type { WorkshopToolDefinition } from './tools.js';

export const WORKSHOP_MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOLS = new Set([
  WORKSHOP_MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
]);

type RequestId = string | number;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: RequestId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface WorkshopMcpServer {
  readonly tools: readonly WorkshopToolDefinition[];
  handle(request: Request): Promise<Response>;
}

export function createWorkshopMcpServer(
  runtime: WorkshopRuntime,
): WorkshopMcpServer {
  const limits = resolveLimits(runtime.limits);
  const dispatcher = createWorkshopToolDispatcher(runtime);
  return {
    tools: dispatcher.tools,
    async handle(request) {
      if (request.method === 'GET') {
        return new Response('SSE listening is not enabled', {
          status: 405,
          headers: { allow: 'POST, OPTIONS' },
        });
      }
      if (request.method === 'OPTIONS') return corsPreflight(request, runtime);
      if (request.method !== 'POST') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { allow: 'GET, POST, OPTIONS' },
        });
      }
      const originFailure = validateOrigin(request, runtime);
      if (originFailure) return originFailure;
      const contentType = request.headers.get('content-type')?.split(';', 1)[0];
      if (contentType !== 'application/json') {
        return httpError(415, 'MCP requests require application/json');
      }
      const accept = request.headers.get('accept') ?? '';
      if (
        !accept.includes('application/json') ||
        !accept.includes('text/event-stream')
      ) {
        return httpError(
          406,
          'MCP requests must accept application/json and text/event-stream',
        );
      }
      let message: JsonRpcMessage;
      try {
        message = await readMessage(request, limits.maxMcpRequestBytes);
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        await observeSafely(runtime.observe, {
          operation: 'authorization.failure',
          outcome: 'error',
          durationMs: 0,
          errorCode: normalized.code,
          ...(request.headers.get('x-request-id')
            ? { requestId: request.headers.get('x-request-id')! }
            : {}),
        });
        return rpcResponse(
          rpcError(null, -32700, normalized.message, normalized.toJSON()),
          normalized.status,
          request,
          runtime,
        );
      }
      if (
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        Array.isArray(message)
      ) {
        return rpcResponse(
          rpcError(message.id ?? null, -32600, 'Invalid JSON-RPC request'),
          400,
          request,
          runtime,
        );
      }
      if (
        message.method !== 'initialize' &&
        message.method !== 'notifications/initialized'
      ) {
        const protocol =
          request.headers.get('mcp-protocol-version') ?? '2025-03-26';
        if (!SUPPORTED_PROTOCOLS.has(protocol)) {
          return httpError(400, 'Unsupported MCP protocol version');
        }
      }
      let principal: WorkshopPrincipal | null;
      try {
        principal = await runtime.resolvePrincipal(request);
        if (!principal) {
          throw new WorkshopError(
            'unauthenticated',
            'MCP authentication is required',
          );
        }
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        return rpcResponse(
          rpcError(message.id ?? null, -32001, normalized.message),
          normalized.status,
          request,
          runtime,
        );
      }
      if (message.id === undefined || message.id === null) {
        return new Response(null, {
          status: 202,
          headers: corsHeaders(request, runtime),
        });
      }
      try {
        const result = await dispatch(
          runtime,
          dispatcher,
          principal,
          message,
          request,
        );
        return rpcResponse(
          { jsonrpc: '2.0', id: message.id, result },
          200,
          request,
          runtime,
        );
      } catch (error) {
        if (error instanceof ProtocolError) {
          return rpcResponse(
            rpcError(message.id, error.rpcCode, error.message),
            200,
            request,
            runtime,
          );
        }
        const normalized = normalizeWorkshopError(error);
        return rpcResponse(
          rpcError(message.id, -32603, normalized.message),
          200,
          request,
          runtime,
        );
      }
    },
  };
}

async function dispatch(
  runtime: WorkshopRuntime,
  dispatcher: WorkshopToolDispatcher,
  principal: WorkshopPrincipal,
  message: JsonRpcMessage,
  request: Request,
): Promise<unknown> {
  switch (message.method) {
    case 'initialize': {
      const params = asObject(message.params);
      const requested =
        typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : WORKSHOP_MCP_PROTOCOL_VERSION;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested)
          ? requested
          : WORKSHOP_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: '@gnolith/workshop', version: '0.3.3' },
        instructions:
          'Search existing tasks before creating overlapping work. Reading a task packet never claims it. All knowledge writes require the latest Taproot revision.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list': {
      const listed = dispatcher.listTools(principal);
      if (!listed.ok) throw dispatchFailure(listed.failure);
      return {
        tools: listed.value.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    }
    case 'tools/call': {
      const params = asObject(message.params);
      const name = typeof params.name === 'string' ? params.name : '';
      const input =
        params.arguments === undefined ? {} : asObject(params.arguments);
      const requestId =
        request.headers.get('x-request-id') ?? crypto.randomUUID();
      const called = await dispatcher.callTool(
        { name, arguments: input },
        { principal, requestId, signal: request.signal },
      );
      if (!called.ok) {
        if (called.failure.kind === 'unknown_tool') {
          throw new ProtocolError(-32602, called.failure.error.message);
        }
        if (
          called.failure.kind === 'unauthenticated' ||
          called.failure.kind === 'forbidden'
        ) {
          throw dispatchFailure(called.failure);
        }
        return {
          content: [{ type: 'text', text: called.failure.error.message }],
          structuredContent: { error: called.failure.error },
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(called.value) }],
        structuredContent: toStructured(called.value),
        isError: false,
      };
    }
    default:
      throw new ProtocolError(
        -32601,
        `Method ${message.method} is not supported`,
      );
  }
}

async function readMessage(
  request: Request,
  maxBytes: number,
): Promise<JsonRpcMessage> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WorkshopError('limit_exceeded', 'MCP request is too large');
  }
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
      throw new WorkshopError('limit_exceeded', 'MCP request is too large');
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
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonRpcMessage;
  } catch {
    throw new WorkshopError('bad_request', 'Invalid JSON request body');
  }
}

function validateOrigin(
  request: Request,
  runtime: WorkshopRuntime,
): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = resolveCorsOrigin(request, runtime);
  if (origin !== new URL(request.url).origin && origin !== allowed) {
    return httpError(403, 'Origin is not allowed');
  }
  return null;
}

function resolveCorsOrigin(
  request: Request,
  runtime: WorkshopRuntime,
): string | null {
  return typeof runtime.corsOrigin === 'function'
    ? runtime.corsOrigin(request)
    : (runtime.corsOrigin ?? null);
}

function corsHeaders(request: Request, runtime: WorkshopRuntime): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const origin = request.headers.get('origin');
  if (
    origin &&
    (origin === new URL(request.url).origin ||
      origin === resolveCorsOrigin(request, runtime))
  ) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return headers;
}

function corsPreflight(request: Request, runtime: WorkshopRuntime): Response {
  const failure = validateOrigin(request, runtime);
  if (failure) return failure;
  const headers = corsHeaders(request, runtime);
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set(
    'access-control-allow-headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Request-Id',
  );
  return new Response(null, { status: 204, headers });
}

function rpcResponse(
  body: unknown,
  status: number,
  request: Request,
  runtime: WorkshopRuntime,
): Response {
  const headers = corsHeaders(request, runtime);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function httpError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function rpcError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(-32602, 'Expected an object');
  }
  return value as Record<string, unknown>;
}

function toStructured(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function dispatchFailure(failure: WorkshopDispatchFailure): WorkshopError {
  return new WorkshopError(
    failure.error.code,
    failure.error.message,
    undefined,
    failure.error.details,
  );
}

class ProtocolError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}
