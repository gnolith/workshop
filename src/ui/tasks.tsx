import type { ReactNode } from 'react';
import type { Task, TaskState } from '../protocol/tasks.js';
import { taskState } from '../protocol/tasks.js';
import { Empty, SafeText } from './primitives.js';

export function TaskFilters({
  state,
  text,
  onChange,
}: {
  state?: TaskState | 'all';
  text?: string;
  onChange?: (filters: { state: TaskState | 'all'; text: string }) => void;
}) {
  return (
    <form
      className="workshop-filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <label>
        Search tasks
        <input
          type="search"
          value={text ?? ''}
          onChange={(event) =>
            onChange?.({
              state: state ?? 'all',
              text: event.currentTarget.value,
            })
          }
        />
      </label>
      <label>
        State
        <select
          value={state ?? 'all'}
          onChange={(event) =>
            onChange?.({
              state: event.currentTarget.value as TaskState | 'all',
              text: text ?? '',
            })
          }
        >
          <option value="all">All states</option>
          <option value="unclaimed">Unclaimed</option>
          <option value="claimed">Claimed</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
      </label>
    </form>
  );
}

export function TaskList({
  tasks,
  onSelect,
}: {
  tasks: readonly Task[];
  onSelect?: (task: Task) => void;
}) {
  return (
    <section className="workshop-stack" aria-label="Research tasks">
      {tasks.length ? (
        tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            {...(onSelect === undefined ? {} : { onSelect })}
          />
        ))
      ) : (
        <Empty>No tasks match these filters.</Empty>
      )}
    </section>
  );
}

export function TaskCard({
  task,
  onSelect,
}: {
  task: Task;
  onSelect?: (task: Task) => void;
}) {
  return (
    <article className="workshop-card">
      <div className="workshop-card-heading">
        <h3>{task.description}</h3>
        <TaskStateBadge task={task} />
      </div>
      {task.role ? (
        <p>
          <span className="workshop-label">Suggested role:</span> {task.role}
        </p>
      ) : null}
      <p className="workshop-clamp">{task.prompt}</p>
      {onSelect ? (
        <button type="button" onClick={() => onSelect(task)}>
          Open task
        </button>
      ) : (
        <a
          href={`/workshop/tasks/${encodeURIComponent(task.id)}`}
          aria-label={`Open task: ${task.description}`}
        >
          Open task
        </a>
      )}
    </article>
  );
}

export function TaskStateBadge({ task }: { task: Task }) {
  const state = taskState(task);
  const labels: Record<TaskState, string> = {
    unclaimed: '○ Unclaimed',
    claimed: '◐ Claimed',
    completed: '✓ Completed',
    archived: '□ Archived',
  };
  return (
    <span className={`workshop-badge workshop-badge-${state}`}>
      {labels[state]}
    </span>
  );
}

export function TaskDetail({
  task,
  controls,
}: {
  task: Task;
  controls?: ReactNode;
}) {
  return (
    <article className="workshop-panel workshop-prose">
      <div className="workshop-card-heading">
        <h1>{task.description}</h1>
        <TaskStateBadge task={task} />
      </div>
      {task.role ? (
        <p>
          <strong>Suggested role:</strong> {task.role}
        </p>
      ) : null}
      <section>
        <h2>Prompt</h2>
        <SafeText>{task.prompt}</SafeText>
      </section>
      {task.result ? (
        <section>
          <h2>Result</h2>
          <SafeText>{task.result}</SafeText>
        </section>
      ) : null}
      {controls}
    </article>
  );
}
