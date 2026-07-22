import { useId } from 'react';
import useSWR from 'swr';
import type { WorkshopCapability } from '../protocol.js';
import type { Memory } from '../protocol/memories.js';
import type { Task } from '../protocol/tasks.js';
import type { WorkshopClientSource } from './configuration.js';
import { WorkshopDashboard } from './dashboard.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import { useWorkshopClient } from './use-workshop-client.js';

export function WorkshopDashboardScreen({
  client: clientSource,
  capabilities,
}: {
  client?: WorkshopClientSource;
  capabilities: readonly WorkshopCapability[];
}) {
  const client = useWorkshopClient(clientSource);
  const instance = useId();
  const canRead = capabilities.includes('read');
  const { data, error, isLoading } = useSWR<
    { tasks: Task[]; memories: Memory[] },
    Error
  >(canRead ? `workshop-dashboard:${instance}` : null, async () => {
    const [tasks, memories] = await Promise.all([
      client.tasks.list({ limit: 200 }),
      client.memories.list({ limit: 200 }),
    ]);
    return { tasks: tasks.items, memories: memories.items };
  });
  if (!canRead) {
    return (
      <p className="workshop-notice" role="status">
        Read access is required to load the Workshop dashboard.
      </p>
    );
  }
  if (isLoading)
    return <WorkshopLoadingStatus label="Loading Workshop dashboard…" />;
  if (error) return <WorkshopErrorNotice error={error} />;
  return (
    <div className="workshop-stack">
      <WorkshopDashboard
        tasks={data?.tasks ?? []}
        memories={data?.memories ?? []}
      />
      <nav className="workshop-actions" aria-label="Workshop shortcuts">
        <a href="/workshop/tasks">Browse tasks</a>
        <a href="/workshop/memories">Browse memories</a>
      </nav>
    </div>
  );
}
