import type { Memory } from '../protocol/memories.js';
import type { Task } from '../protocol/tasks.js';

export function WorkshopDashboard({
  tasks,
  memories,
}: {
  tasks: readonly Task[];
  memories: readonly Memory[];
}) {
  const active = tasks.filter((task) => !task.completedAt && !task.archivedAt);
  return (
    <section
      className="workshop-panel"
      aria-labelledby="workshop-dashboard-title"
    >
      <h2 id="workshop-dashboard-title">Research Workshop</h2>
      <div className="workshop-stats">
        <Stat label="Active tasks" value={active.length} />
        <Stat
          label="Claimed"
          value={active.filter((task) => task.claimed).length}
        />
        <Stat label="Memories" value={memories.length} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="workshop-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
