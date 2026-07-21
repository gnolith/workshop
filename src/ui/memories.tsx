import { useState } from 'react';
import type { Memory, UpsertMemoryInput } from '../protocol/memories.js';
import { Empty, PermissionNotice, SafeText } from './primitives.js';

export function MemoryList({
  memories,
  onSelect,
}: {
  memories: readonly Memory[];
  onSelect?: (memory: Memory) => void;
}) {
  return (
    <section className="workshop-stack" aria-label="Reusable memories">
      {memories.length ? (
        memories.map((memory) => (
          <MemoryCard
            key={memory.slug}
            memory={memory}
            {...(onSelect === undefined ? {} : { onSelect })}
          />
        ))
      ) : (
        <Empty>No memories yet.</Empty>
      )}
    </section>
  );
}

export function MemoryCard({
  memory,
  onSelect,
}: {
  memory: Memory;
  onSelect?: (memory: Memory) => void;
}) {
  return (
    <article className="workshop-card">
      <h3>{memory.slug}</h3>
      <p>{memory.description}</p>
      <SafeText>{memory.content}</SafeText>
      {onSelect ? (
        <button type="button" onClick={() => onSelect(memory)}>
          Edit memory
        </button>
      ) : null}
    </article>
  );
}

export function MemoryEditor({
  initial,
  allowed = true,
  error,
  busy = false,
  onSave,
}: {
  initial?: Partial<UpsertMemoryInput>;
  allowed?: boolean;
  error?: string;
  busy?: boolean;
  onSave?: (input: UpsertMemoryInput) => void | Promise<void>;
}) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  if (!allowed) return <PermissionNotice capability="memory-write" />;
  return (
    <form
      className="workshop-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave?.({
          description: description.trim(),
          content: content.trim(),
        });
      }}
    >
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
        Guidance
        <textarea
          required
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save memory'}
      </button>
    </form>
  );
}
