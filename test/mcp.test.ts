import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createWorkshopMcpServer } from '../src/mcp.js';
import { createWorkshopMcpHandler } from '../src/site.js';
import { createTestContext, mcpRequest } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

async function createServerContext() {
  const context = await createTestContext();
  disposals.push(context.dispose);
  return { ...context, server: createWorkshopMcpServer(context.runtime) };
}

describe('Streamable HTTP MCP', () => {
  it('ships the complete deterministic tool schema surface', async () => {
    const { server } = await createServerContext();
    expect(server.tools).toHaveLength(34);
    expect(new Set(server.tools.map((tool) => tool.name)).size).toBe(34);
    for (const tool of server.tools) {
      expect(tool.title.trim()).not.toBe('');
      expect(tool.description.trim()).not.toBe('');
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    const packet = server.tools.find((tool) => tool.name === 'get_task_packet');
    expect(packet?.inputSchema.required).toEqual(['id']);
    const archive = server.tools.find((tool) => tool.name === 'archive_task');
    expect(archive?.inputSchema.required).toEqual(['id']);
    expect(archive?.inputSchema.properties).toHaveProperty('expectedRevision');
    expect(archive?.inputSchema.properties.expectedRevision).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
  });

  it('interoperates with the official MCP TypeScript client', async () => {
    const { server } = await createServerContext();
    const transport = new StreamableHTTPClientTransport(
      new URL('https://site.example/api/workshop/mcp'),
      {
        requestInit: { headers: { authorization: 'Bearer writer' } },
        fetch: (input, init) => server.handle(new Request(input, init)),
      },
    );
    const client = new Client({ name: 'workshop-sdk-test', version: '1.0.0' });
    // SDK 1.x's transport declarations are not exactOptionalPropertyTypes-clean.
    await client.connect(transport as Transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('create_task');
    const called = await client.callTool({
      name: 'create_task',
      arguments: { description: 'SDK client task', prompt: 'Execute safely' },
    });
    expect(called).toMatchObject({
      isError: false,
      structuredContent: { id: expect.any(String) },
    });
    await client.close();
  });

  it('initializes and negotiates the stable protocol', async () => {
    const { server } = await createServerContext();
    const response = await server.handle(
      mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });
  });

  it('lists deterministic capability-filtered tools and never exposes reset', async () => {
    const { server } = await createServerContext();
    const reader = await server.handle(
      mcpRequest(
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        'reader',
        '2025-11-25',
      ),
    );
    const readerBody = (await reader.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const readerNames = readerBody.result.tools.map((tool) => tool.name);
    expect(readerNames).toContain('list_tasks');
    expect(readerNames).not.toContain('create_task');
    const admin = await server.handle(
      mcpRequest(
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        'admin',
        '2025-11-25',
      ),
    );
    const adminBody = (await admin.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = adminBody.result.tools.map((tool) => tool.name);
    expect(names).toContain('create_task');
    expect(names).toContain('add_reference');
    expect(names).not.toContain('reset_abandoned_claim');
    expect(names).toEqual([...names]);
  });

  it('calls tools with structured content and serializes correctable errors', async () => {
    const { server } = await createServerContext();
    const created = await server.handle(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'create_task',
            arguments: { description: 'MCP task', prompt: 'Work' },
          },
        },
        'writer',
        '2025-11-25',
      ),
    );
    const body = (await created.json()) as {
      result: { isError: boolean; structuredContent: { id: string } };
    };
    expect(body.result).toMatchObject({
      isError: false,
      structuredContent: { id: expect.any(String) },
    });
    const conflict = await server.handle(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'complete_task',
            arguments: {
              id: body.result.structuredContent.id,
              result: 'Not claimed',
            },
          },
        },
        'writer',
        '2025-11-25',
      ),
    );
    await expect(conflict.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'conflict' } },
      },
    });
  });

  it('rejects anonymous, oversized, invalid-origin, and unsupported-version requests', async () => {
    const { server, runtime } = await createServerContext();
    const anonymous = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      'missing',
    );
    expect((await server.handle(anonymous)).status).toBe(401);
    const wrongVersion = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      'admin',
      '2099-01-01',
    );
    expect((await server.handle(wrongVersion)).status).toBe(400);
    const origin = mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' });
    origin.headers.set('origin', 'https://attacker.example');
    expect((await server.handle(origin)).status).toBe(403);
    const handler = createWorkshopMcpHandler({
      ...runtime,
      limits: { maxMcpRequestBytes: 8 },
    });
    expect(
      (await handler(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })))
        .status,
    ).toBe(413);
  });
});
