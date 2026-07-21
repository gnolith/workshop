import { useId } from 'react';
import useSWR from 'swr';
import type { WorkshopCapability } from '../protocol.js';
import type { TaskPage } from '../protocol/tasks.js';
import type { WorkshopClientSource } from './configuration.js';
import { hasUiCapability } from './configuration.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import { TaskList } from './tasks.js';
import { useWorkshopClient } from './use-workshop-client.js';

export function WorkshopEntityTasksScreen({
  client: clientSource,
  capabilities,
  entityId,
}: {
  client?: WorkshopClientSource;
  capabilities: readonly WorkshopCapability[];
  entityId?: string;
}) {
  const client = useWorkshopClient(clientSource);
  const instance = useId();
  const tasks = useSWR<TaskPage, Error>(
    entityId && hasUiCapability(capabilities, 'read')
      ? `workshop-entity-tasks:${instance}:${entityId}`
      : null,
    () => client.tasks.search({ text: entityId ?? '', limit: 25 }),
  );
  if (!entityId) {
    return (
      <p className="workshop-notice" role="status">
        Select an entity to inspect related tasks.
      </p>
    );
  }
  if (!hasUiCapability(capabilities, 'read')) {
    return (
      <p className="workshop-notice" role="status">
        Read access is required to inspect related tasks.
      </p>
    );
  }
  if (tasks.isLoading)
    return <WorkshopLoadingStatus label="Loading related tasks…" />;
  if (tasks.error) return <WorkshopErrorNotice error={tasks.error} />;
  return <TaskList tasks={tasks.data?.items ?? []} />;
}
