// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkshopError } from '../src/protocol/errors.js';
import type {
  Memory,
  UpsertMemoryInput,
  OnboardingSeedPlan,
  Task,
  WorkshopClient,
} from '../src/protocol.js';
import {
  createWorkshopPlugin,
  WorkshopMcpStatusScreen,
  WorkshopMemoriesScreen,
  WorkshopOnboardingScreen,
  WorkshopTasksScreen,
} from '../src/ui.js';

const now = '2026-07-20T12:00:00.000Z';
const task: Task = {
  id: 'task-1',
  description: 'Verify archive sources',
  prompt: 'Inspect the cited archive records.',
  contextQueries: [],
  memorySlugs: [],
  claimed: false,
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const memory: Memory = {
  slug: 'citation-policy',
  description: 'Citation rules',
  content: 'Cite the original record.',
  revision: 1,
  createdAt: now,
  updatedAt: now,
};

afterEach(() => cleanup());

describe('configured Waystone screens', () => {
  it('loads, filters, creates, opens packets, and claims tasks', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    const { container } = render(
      <WorkshopTasksScreen
        client={client}
        capabilities={['read', 'task-write']}
      />,
    );

    expect(await screen.findByText(task.description)).toBeTruthy();
    await user.type(screen.getByLabelText('Search tasks'), 'archive');
    await waitFor(() =>
      expect(client.tasks.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'archive' }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await user.type(screen.getByLabelText('Description'), 'Check source');
    await user.type(screen.getByLabelText('Prompt'), 'Review the source.');
    await user.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(client.tasks.create).toHaveBeenCalledOnce());

    expect(await screen.findByText('Current task packet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Claim task' }));
    await waitFor(() => expect(client.tasks.claim).toHaveBeenCalledOnce());
    client.tasks.complete = vi.fn(async () => {
      throw new WorkshopError(
        'conflict',
        'The task changed after it was loaded.',
        409,
      );
    });
    await user.type(await screen.findByLabelText('Task result'), 'Done.');
    await user.click(screen.getByRole('button', { name: 'Complete task' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Refresh current data before retrying.',
    );

    const accessibility = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it('creates and edits memories with optimistic revision guards', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    render(
      <WorkshopMemoriesScreen
        client={client}
        capabilities={['read', 'memory-write']}
      />,
    );
    expect(await screen.findByText(memory.slug)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Edit memory' }));
    const guidance = screen.getByLabelText('Guidance');
    await user.clear(guidance);
    await user.type(guidance, 'Prefer primary sources.');
    await user.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() =>
      expect(client.memories.upsert).toHaveBeenCalledWith(
        memory.slug,
        expect.objectContaining({ expectedUpdatedAt: now }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Create memory' }));
    await user.type(screen.getByLabelText('Memory slug'), 'new-guidance');
    await user.type(screen.getByLabelText('Description'), 'New rules');
    await user.type(screen.getByLabelText('Guidance'), 'Verify dates.');
    await user.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() =>
      expect(client.memories.upsert).toHaveBeenLastCalledWith(
        'new-guidance',
        expect.objectContaining({ content: 'Verify dates.' }),
      ),
    );
  });

  it('previews/applies onboarding, displays MCP state, and preserves permissions', async () => {
    const user = userEvent.setup();
    const plan: OnboardingSeedPlan = {
      key: 'initial-research',
      defaultLanguage: 'en',
      entities: [{ kind: 'topic', label: 'Archives' }],
      memories: [],
      tasks: [],
    };
    const preview = vi.fn(async () => plan);
    const apply = vi.fn(async () => ({
      key: plan.key,
      state: 'completed' as const,
      retryable: false,
      completedSteps: 1,
      totalSteps: 1,
      steps: [
        {
          key: `onboarding:${plan.key}:entity:0`,
          ordinal: 0,
          kind: 'entity' as const,
          state: 'completed' as const,
          attempts: 1,
        },
      ],
      entities: [{}],
      memories: [],
      tasks: [],
    }));
    const { rerender } = render(
      <WorkshopOnboardingScreen
        controller={{ preview, apply }}
        capabilities={['read', 'task-write', 'memory-write', 'knowledge-write']}
      />,
    );
    await user.type(screen.getByLabelText('Topics, one per line'), 'Archives');
    await user.click(screen.getByRole('button', { name: 'Preview seed plan' }));
    expect(await screen.findByText('Proposed seed plan')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Apply this seed plan' }),
    );
    expect(
      await screen.findByText(/Seed initial-research applied/u),
    ).toBeTruthy();

    rerender(
      <WorkshopMcpStatusScreen
        loadStatus={async () => ({
          status: 'connected',
          endpoint: '/api/workshop/mcp',
        })}
      />,
    );
    expect(await screen.findByText('connected')).toBeTruthy();

    const denied = mockClient();
    rerender(<WorkshopTasksScreen client={denied} capabilities={[]} />);
    expect(await screen.findByText(/Read access is required/u)).toBeTruthy();
    expect(denied.tasks.search).not.toHaveBeenCalled();
  });

  it('registers real configured route components', async () => {
    const client = mockClient();
    const plugin = createWorkshopPlugin({
      client,
      capabilities: ['read'],
    });
    const TasksRoute = plugin.routes[0]?.component;
    expect(TasksRoute).toBeDefined();
    render(TasksRoute ? <TasksRoute /> : null);
    expect(await screen.findByText(task.description)).toBeTruthy();
  });
});

function mockClient(): WorkshopClient {
  let currentTask = { ...task };
  return {
    tasks: {
      list: vi.fn(async () => ({ items: [currentTask], cursor: null })),
      search: vi.fn(async () => ({ items: [currentTask], cursor: null })),
      get: vi.fn(async () => currentTask),
      getPacket: vi.fn(async () => ({
        task: currentTask,
        context: [],
        memories: [],
        resolvedAt: now,
      })),
      create: vi.fn(async (input) => {
        currentTask = { ...task, ...input, id: 'created-task' };
        return currentTask;
      }),
      update: vi.fn(async (_id, input) => {
        currentTask = { ...currentTask, ...input };
        return currentTask;
      }),
      archive: vi.fn(async () => ({ ...currentTask, archivedAt: now })),
      claim: vi.fn(async () => {
        currentTask = { ...currentTask, claimed: true, claimedAt: now };
        return currentTask;
      }),
      complete: vi.fn(async (_id, result) => ({
        ...currentTask,
        claimed: false,
        completedAt: now,
        result,
      })),
    },
    memories: {
      list: vi.fn(async () => ({ items: [memory], cursor: null })),
      get: vi.fn(async () => memory),
      upsert: vi.fn(async (slug: string, input: UpsertMemoryInput) => ({
        slug,
        description: input.description,
        content: input.content,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })),
    },
  };
}
