import { useDeferredValue, useId, useState } from 'react';
import useSWR from 'swr';
import type { WorkshopCapability } from '../protocol.js';
import type {
  CreateTaskInput,
  TaskPage,
  TaskState,
} from '../protocol/tasks.js';
import type { WorkshopClientSource } from './configuration.js';
import { hasUiCapability } from './configuration.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import { TaskEditor } from './task-controls.js';
import { TaskWorkspace } from './task-workspace.js';
import { TaskFilters, TaskList } from './tasks.js';
import { useWorkshopClient } from './use-workshop-client.js';

export function WorkshopTasksScreen({
  client: clientSource,
  capabilities,
}: {
  client?: WorkshopClientSource;
  capabilities: readonly WorkshopCapability[];
}) {
  const client = useWorkshopClient(clientSource);
  const instance = useId();
  const [state, setState] = useState<TaskState | 'all'>('all');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const deferredText = useDeferredValue(text);
  const canRead = hasUiCapability(capabilities, 'read');
  const canWrite = hasUiCapability(capabilities, 'task-write');
  const filters = {
    ...(state === 'all' ? {} : { state }),
    ...(deferredText.trim() ? { text: deferredText.trim() } : {}),
    limit: 100,
  };
  const tasks = useSWR<TaskPage, Error>(
    canRead ? `workshop-tasks:${instance}:${JSON.stringify(filters)}` : null,
    () => client.tasks.search(filters),
  );
  if (!canRead) {
    return (
      <p className="workshop-notice" role="status">
        Read access is required to browse Workshop tasks.
      </p>
    );
  }
  if (selectedId) {
    return (
      <TaskWorkspace
        client={client}
        taskId={selectedId}
        canWrite={canWrite}
        onBack={() => setSelectedId(undefined)}
        onChanged={async () => {
          await tasks.mutate();
        }}
      />
    );
  }
  const create = async (input: CreateTaskInput) => {
    setActionError(undefined);
    try {
      const created = await client.tasks.create(input);
      setCreating(false);
      await tasks.mutate();
      setSelectedId(created.id);
    } catch (error) {
      setActionError(error);
    }
  };
  return (
    <section className="workshop-screen" aria-labelledby="workshop-tasks-title">
      <div className="workshop-card-heading">
        <h1 id="workshop-tasks-title">Research tasks</h1>
        {canWrite ? (
          <button type="button" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Cancel creation' : 'Create task'}
          </button>
        ) : null}
      </div>
      {!canWrite ? (
        <p className="workshop-notice" role="status">
          You can inspect tasks and packets, but task mutations are unavailable.
        </p>
      ) : null}
      {actionError ? <WorkshopErrorNotice error={actionError} /> : null}
      {creating ? <TaskEditor onSave={create} /> : null}
      <TaskFilters
        state={state}
        text={text}
        onChange={(next) => {
          setState(next.state);
          setText(next.text);
        }}
      />
      {tasks.isLoading ? (
        <WorkshopLoadingStatus label="Loading tasks…" />
      ) : tasks.error ? (
        <WorkshopErrorNotice error={tasks.error} />
      ) : (
        <TaskList
          tasks={tasks.data?.items ?? []}
          onSelect={(task) => setSelectedId(task.id)}
        />
      )}
      {tasks.data?.cursor ? (
        <p className="workshop-notice">
          Refine the filters to inspect tasks beyond this first page.
        </p>
      ) : null}
    </section>
  );
}
