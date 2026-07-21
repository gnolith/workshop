import type { TaskPacket } from '../protocol/tasks.js';
import { MemoryCard } from './memories.js';

export function TaskPacketView({ packet }: { packet: TaskPacket }) {
  return (
    <section className="workshop-stack" aria-labelledby="packet-title">
      <h2 id="packet-title">Current task packet</h2>
      <p>
        Resolved{' '}
        <time dateTime={packet.resolvedAt}>
          {new Date(packet.resolvedAt).toLocaleString()}
        </time>
        . Reading this packet did not claim the task.
      </p>
      {packet.context.map((query, index) => (
        <TaskContextQueryResult
          key={`${query.sparql}-${index}`}
          query={query}
        />
      ))}
      <section>
        <h3>Memories</h3>
        {packet.memories.map((memory) => (
          <MemoryCard key={memory.slug} memory={memory} />
        ))}
      </section>
    </section>
  );
}

export function TaskContextQueryResult({
  query,
}: {
  query: TaskPacket['context'][number];
}) {
  return (
    <article className="workshop-card">
      <h3>{query.label ?? 'Context query'}</h3>
      <details>
        <summary>SPARQL</summary>
        <pre>
          <code>{query.sparql}</code>
        </pre>
      </details>
      {query.error ? (
        <div className="workshop-error" role="alert">
          <strong>{query.error.code}</strong>: {query.error.message}
        </div>
      ) : (
        <pre className="workshop-result">
          {JSON.stringify(query.result, null, 2)}
        </pre>
      )}
    </article>
  );
}
