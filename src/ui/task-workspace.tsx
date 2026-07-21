import { useId, useState } from 'react';
import useSWR from 'swr';
import type { CreateTaskInput, Task, TaskPacket } from '../protocol/tasks.js';
import type { WorkshopClient } from '../protocol/client.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import {
  TaskClaimControl,
  TaskCompletionForm,
  TaskEditor,
} from './task-controls.js';
import { TaskPacketView } from './task-packet.js';
import { TaskDetail } from './tasks.js';

export function TaskWorkspace({
  client,
  taskId,
  canWrite,
  onBack,
  onChanged,
}: {
  client: WorkshopClient;
  taskId: string;
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const instance = useId();
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const task = useSWR<Task, Error>(`workshop-task:${instance}:${taskId}`, () =>
    client.tasks.get(taskId),
  );
  const packet = useSWR<TaskPacket, Error>(
    `workshop-packet:${instance}:${taskId}`,
    () => client.tasks.getPacket(taskId),
  );
  const refresh = async () => {
    await Promise.all([task.mutate(), packet.mutate(), onChanged()]);
  };
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await operation();
      await refresh();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  };
  if (task.isLoading) return <WorkshopLoadingStatus label="Loading task…" />;
  if (task.error) return <WorkshopErrorNotice error={task.error} />;
  if (!task.data) return <WorkshopErrorNotice error="Task was not returned" />;
  const current = task.data;
  const controls = canWrite ? (
    <div className="workshop-actions">
      {!current.claimed && !current.completedAt && !current.archivedAt ? (
        <TaskClaimControl
          task={current}
          allowed
          busy={busy}
          onClaim={() => action(() => client.tasks.claim(current.id))}
        />
      ) : null}
      {current.claimed && !current.completedAt && !current.archivedAt ? (
        <TaskCompletionForm
          allowed
          busy={busy}
          onComplete={(result) =>
            action(() => client.tasks.complete(current.id, result))
          }
        />
      ) : null}
      {!current.completedAt && !current.archivedAt ? (
        <button type="button" onClick={() => setEditing((value) => !value)}>
          {editing ? 'Cancel edit' : 'Edit task'}
        </button>
      ) : null}
      {!current.completedAt && !current.archivedAt ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void action(() =>
              client.tasks.archive(current.id, current.updatedAt),
            );
          }}
        >
          Archive task
        </button>
      ) : null}
    </div>
  ) : (
    <p className="workshop-notice" role="status">
      You have read-only access to this task.
    </p>
  );
  return (
    <div className="workshop-stack">
      <button type="button" onClick={onBack}>
        Back to tasks
      </button>
      {actionError ? <WorkshopErrorNotice error={actionError} /> : null}
      <TaskDetail task={current} controls={controls} />
      {editing ? (
        <TaskEditor
          key={current.updatedAt}
          initial={current}
          busy={busy}
          onSave={(input: CreateTaskInput) =>
            action(async () => {
              const changes = {
                description: input.description,
                prompt: input.prompt,
                ...(input.role === undefined ? {} : { role: input.role }),
                ...(input.contextQueries === undefined
                  ? {}
                  : { contextQueries: input.contextQueries }),
                ...(input.memorySlugs === undefined
                  ? {}
                  : { memorySlugs: input.memorySlugs }),
              };
              await client.tasks.update(current.id, {
                ...changes,
                expectedUpdatedAt: current.updatedAt,
              });
              setEditing(false);
            })
          }
        />
      ) : null}
      {packet.isLoading ? (
        <WorkshopLoadingStatus label="Compiling current task packet…" />
      ) : packet.error ? (
        <WorkshopErrorNotice error={packet.error} />
      ) : packet.data ? (
        <TaskPacketView packet={packet.data} />
      ) : null}
    </div>
  );
}
