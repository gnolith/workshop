import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkshopToolDispatcher,
  type WorkshopToolDispatchContext,
} from '../src/mcp.js';
import type { WorkshopPrincipal } from '../src/protocol.js';
import { createTestContext } from './helpers.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(disposals.splice(0).map((dispose) => dispose())),
);

const reader: WorkshopPrincipal = {
  id: 'agent:reader',
  capabilities: ['read'],
};
const writer: WorkshopPrincipal = {
  id: 'agent:writer',
  capabilities: ['read', 'task-write', 'knowledge-write', 'memory-write'],
};
const admin: WorkshopPrincipal = {
  id: 'agent:admin',
  capabilities: ['admin'],
};

function dispatchContext(
  principal: WorkshopPrincipal | null,
): WorkshopToolDispatchContext {
  return { principal, requestId: 'dispatch-test' };
}

async function setup() {
  const context = await createTestContext();
  disposals.push(context.dispose);
  return {
    ...context,
    dispatcher: createWorkshopToolDispatcher(context.runtime),
  };
}

describe('transport-neutral Workshop tool dispatcher', () => {
  it('has a complete deterministic registry and filters it by capability', async () => {
    const { dispatcher } = await setup();
    expect(dispatcher.tools).toHaveLength(34);
    expect(new Set(dispatcher.tools.map((tool) => tool.name)).size).toBe(34);

    const anonymous = dispatcher.listTools(null);
    expect(anonymous).toMatchObject({
      ok: false,
      failure: { kind: 'unauthenticated' },
    });

    const readable = dispatcher.listTools(reader);
    expect(readable.ok).toBe(true);
    if (readable.ok) {
      const names = readable.value.map((tool) => tool.name);
      expect(names).toContain('list_tasks');
      expect(names).not.toContain('create_task');
    }

    const administrative = dispatcher.listTools(admin);
    expect(administrative.ok).toBe(true);
    if (administrative.ok) {
      expect(administrative.value).toHaveLength(34);
    }
  });

  it('denies unknown tools without forwarding them to knowledge', async () => {
    const { dispatcher, knowledgeCalls } = await setup();
    const result = await dispatcher.callTool(
      { name: 'not_a_workshop_tool', arguments: { entityId: 'Q1' } },
      dispatchContext(writer),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: 'unknown_tool',
        error: { code: 'bad_request' },
      },
    });
    expect(knowledgeCalls).toEqual([]);
  });

  it('authorizes calls before execution and returns typed failures', async () => {
    const { dispatcher } = await setup();
    const forbidden = await dispatcher.callTool(
      {
        name: 'create_task',
        arguments: { description: 'No write', prompt: 'Must be denied' },
      },
      dispatchContext(reader),
    );
    expect(forbidden).toMatchObject({
      ok: false,
      failure: { kind: 'forbidden', error: { code: 'forbidden' } },
    });

    const invalid = await dispatcher.callTool(
      { name: 'get_task_packet', arguments: {} },
      dispatchContext(writer),
    );
    expect(invalid).toMatchObject({
      ok: false,
      failure: {
        kind: 'invalid_arguments',
        error: { code: 'validation_failed', details: { field: 'id' } },
      },
    });
  });

  it('executes domain tools without an HTTP request', async () => {
    const { dispatcher } = await setup();
    const result = await dispatcher.callTool(
      {
        name: 'create_task',
        arguments: {
          description: 'Process-local task',
          prompt: 'Execute without an HTTP transport',
        },
      },
      dispatchContext(writer),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { id: expect.any(String), description: 'Process-local task' },
    });
  });
});
