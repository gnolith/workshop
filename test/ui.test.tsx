import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/protocol/tasks.js';
import {
  McpStatusPanel,
  MemoryEditor,
  TaskDetail,
  TaskEditor,
  TaskPacketView,
  TaskStateBadge,
  WorkshopOnboarding,
  workshopPlugin,
} from '../src/ui.js';

const task: Task = {
  id: 'task-1',
  description: '<Research & verify>',
  prompt: '<script>alert(1)</script> is plain text',
  contextQueries: [],
  memorySlugs: [],
  claimed: true,
  claimedAt: '2026-07-20T12:00:00.000Z',
  createdAt: '2026-07-20T12:00:00.000Z',
  updatedAt: '2026-07-20T12:00:00.000Z',
};

describe('Waystone UI surface', () => {
  it('registers all required contribution families structurally', () => {
    expect(workshopPlugin).toMatchObject({ id: 'workshop', name: 'Workshop' });
    expect(workshopPlugin.navigation.map((item) => item.label)).toEqual([
      'Tasks',
      'Memories',
    ]);
    expect(workshopPlugin.dashboardPanels).toHaveLength(1);
    expect(workshopPlugin.onboarding).toHaveLength(1);
    expect(workshopPlugin.settingsPanels[0]).toMatchObject({
      capability: 'admin',
    });
    expect(workshopPlugin.entityPanels).toHaveLength(1);
  });

  it('renders state with text and escapes untrusted content', () => {
    const markup = renderToStaticMarkup(
      <TaskDetail task={task} controls={<TaskStateBadge task={task} />} />,
    );
    expect(markup).toContain('◐ Claimed');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
  });

  it('renders packets, editors, onboarding, permission, and MCP status accessibly', () => {
    const packet = renderToStaticMarkup(
      <TaskPacketView
        packet={{
          task,
          context: [
            {
              label: 'Broken query',
              sparql: 'ASK { }',
              error: { code: 'query_timeout', message: 'Timed out' },
            },
          ],
          memories: [],
          resolvedAt: task.updatedAt,
        }}
      />,
    );
    expect(packet).toContain('role="alert"');
    expect(packet).toContain('did not claim');
    expect(renderToStaticMarkup(<TaskEditor allowed={false} />)).toContain(
      'task-write',
    );
    expect(renderToStaticMarkup(<MemoryEditor />)).toContain('<form');
    expect(renderToStaticMarkup(<WorkshopOnboarding />)).toContain(
      'Preview seed plan',
    );
    expect(
      renderToStaticMarkup(<McpStatusPanel status="unauthorized" />),
    ).toContain('unauthorized');
  });
});
