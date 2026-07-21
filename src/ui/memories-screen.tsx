import { useDeferredValue, useId, useState } from 'react';
import useSWR from 'swr';
import type { WorkshopCapability } from '../protocol.js';
import type {
  Memory,
  MemoryPage,
  UpsertMemoryInput,
} from '../protocol/memories.js';
import type { WorkshopClientSource } from './configuration.js';
import { hasUiCapability } from './configuration.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import { MemoryEditor, MemoryList } from './memories.js';
import { useWorkshopClient } from './use-workshop-client.js';

export function WorkshopMemoriesScreen({
  client: clientSource,
  capabilities,
}: {
  client?: WorkshopClientSource;
  capabilities: readonly WorkshopCapability[];
}) {
  const client = useWorkshopClient(clientSource);
  const instance = useId();
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [selected, setSelected] = useState<Memory>();
  const [actionError, setActionError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const deferredText = useDeferredValue(text);
  const canRead = hasUiCapability(capabilities, 'read');
  const canWrite = hasUiCapability(capabilities, 'memory-write');
  const memories = useSWR<MemoryPage, Error>(
    canRead ? `workshop-memories:${instance}:${deferredText}` : null,
    () =>
      client.memories.list({
        ...(deferredText.trim() ? { text: deferredText.trim() } : {}),
        limit: 100,
      }),
  );
  if (!canRead) {
    return (
      <p className="workshop-notice" role="status">
        Read access is required to browse Workshop memories.
      </p>
    );
  }
  const save = async (
    slug: string,
    input: UpsertMemoryInput,
    expectedUpdatedAt?: string,
  ) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await client.memories.upsert(slug, {
        ...input,
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      });
      setCreating(false);
      setSelected(undefined);
      setNewSlug('');
      await memories.mutate();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="workshop-screen"
      aria-labelledby="workshop-memories-title"
    >
      <div className="workshop-card-heading">
        <h1 id="workshop-memories-title">Reusable memories</h1>
        {canWrite ? (
          <button
            type="button"
            onClick={() => {
              setSelected(undefined);
              setCreating((value) => !value);
            }}
          >
            {creating ? 'Cancel creation' : 'Create memory'}
          </button>
        ) : null}
      </div>
      {!canWrite ? (
        <p className="workshop-notice" role="status">
          You have read-only access to reusable guidance.
        </p>
      ) : null}
      {actionError ? <WorkshopErrorNotice error={actionError} /> : null}
      {creating ? (
        <div className="workshop-panel workshop-stack">
          <label className="workshop-label-control">
            Memory slug
            <input
              required
              value={newSlug}
              onChange={(event) => setNewSlug(event.currentTarget.value)}
            />
          </label>
          <MemoryEditor
            busy={busy}
            onSave={(input) => save(newSlug.trim(), input)}
          />
        </div>
      ) : null}
      {selected ? (
        <div className="workshop-panel workshop-stack">
          <div className="workshop-card-heading">
            <h2>Edit {selected.slug}</h2>
            <button type="button" onClick={() => setSelected(undefined)}>
              Cancel edit
            </button>
          </div>
          <MemoryEditor
            key={selected.updatedAt}
            initial={selected}
            busy={busy}
            onSave={(input) => save(selected.slug, input, selected.updatedAt)}
          />
        </div>
      ) : null}
      <label className="workshop-label-control">
        Search memories
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </label>
      {memories.isLoading ? (
        <WorkshopLoadingStatus label="Loading memories…" />
      ) : memories.error ? (
        <WorkshopErrorNotice error={memories.error} />
      ) : (
        <MemoryList
          memories={memories.data?.items ?? []}
          {...(canWrite ? { onSelect: setSelected } : {})}
        />
      )}
    </section>
  );
}
