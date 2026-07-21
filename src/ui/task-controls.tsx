import { useState, type FormEvent } from 'react';
import type { ContextQuery, CreateTaskInput, Task } from '../protocol/tasks.js';
import { PermissionNotice } from './primitives.js';

export function TaskClaimControl({
  task,
  allowed,
  onClaim,
  busy = false,
}: {
  task: Task;
  allowed: boolean;
  onClaim?: () => void | Promise<void>;
  busy?: boolean;
}) {
  if (!allowed) return <PermissionNotice capability="task-write" />;
  return (
    <button
      type="button"
      disabled={
        busy ||
        task.claimed ||
        Boolean(task.completedAt) ||
        Boolean(task.archivedAt)
      }
      onClick={() => void onClaim?.()}
    >
      Claim task
    </button>
  );
}

export function TaskCompletionForm({
  allowed,
  onComplete,
  busy = false,
}: {
  allowed: boolean;
  onComplete?: (result: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [result, setResult] = useState('');
  if (!allowed) return <PermissionNotice capability="task-write" />;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (result.trim()) void onComplete?.(result.trim());
      }}
    >
      <label>
        Task result
        <textarea
          required
          value={result}
          onChange={(event) => setResult(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Completing…' : 'Complete task'}
      </button>
    </form>
  );
}

export function TaskEditor({
  initial,
  allowed = true,
  error,
  busy = false,
  onSave,
}: {
  initial?: Partial<CreateTaskInput>;
  allowed?: boolean;
  error?: string;
  busy?: boolean;
  onSave?: (input: CreateTaskInput) => void | Promise<void>;
}) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [memorySlugs, setMemorySlugs] = useState(
    (initial?.memorySlugs ?? []).join('\n'),
  );
  const [queries, setQueries] = useState<ContextQuery[]>(
    initial?.contextQueries?.map((query) => ({ ...query })) ?? [],
  );
  if (!allowed) return <PermissionNotice capability="task-write" />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave?.({
      description: description.trim(),
      prompt: prompt.trim(),
      ...(role.trim() ? { role: role.trim() } : {}),
      contextQueries: queries.map((query) => ({
        ...(query.label?.trim() ? { label: query.label.trim() } : {}),
        sparql: query.sparql.trim(),
      })),
      memorySlugs: memorySlugs
        .split(/[\s,]+/u)
        .map((slug) => slug.trim())
        .filter(Boolean),
    });
  };
  return (
    <form className="workshop-form" onSubmit={submit}>
      {error ? (
        <div className="workshop-error" role="alert">
          {error}
        </div>
      ) : null}
      <label>
        Description
        <input
          required
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <label>
        Suggested role
        <input
          value={role}
          onChange={(event) => setRole(event.currentTarget.value)}
        />
      </label>
      <label>
        Prompt
        <textarea
          required
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
      </label>
      <label>
        Memory slugs, separated by spaces, commas, or lines
        <textarea
          value={memorySlugs}
          onChange={(event) => setMemorySlugs(event.currentTarget.value)}
        />
      </label>
      <fieldset className="workshop-fieldset">
        <legend>Current-context SPARQL queries</legend>
        {queries.map((query, index) => (
          <div className="workshop-query-editor" key={index}>
            <label>
              Optional label
              <input
                value={query.label ?? ''}
                onChange={(event) =>
                  setQueries((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, label: event.currentTarget.value }
                        : item,
                    ),
                  )
                }
              />
            </label>
            <label>
              Read-only SPARQL
              <textarea
                required
                value={query.sparql}
                onChange={(event) =>
                  setQueries((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, sparql: event.currentTarget.value }
                        : item,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setQueries((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              Remove query
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setQueries((current) => [...current, { sparql: '' }])}
        >
          Add context query
        </button>
      </fieldset>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save task'}
      </button>
    </form>
  );
}
