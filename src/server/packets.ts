import { WorkshopError } from '../protocol/errors.js';
import type { TaskPacket } from '../protocol/tasks.js';
import type { MemoryService } from './memories.js';
import type { TaskService } from './tasks.js';
import type { AuthorizationContext } from './authorization.js';

export interface PacketServiceOptions {
  clock?: () => Date;
}

export class PacketService {
  readonly #clock: () => Date;

  constructor(
    readonly tasks: TaskService,
    readonly memories: MemoryService,
    options: PacketServiceOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(
    id: string,
    authorization: AuthorizationContext,
    signal?: AbortSignal,
  ): Promise<TaskPacket> {
    const task = await this.tasks.get(id, authorization);
    void signal;
    // The current SPARQL port is installation-wide and cannot scope its
    // dataset by VisibilityScopeV1. Never execute it for a public packet.
    const context = task.contextQueries.map((query) => ({
      ...(query.label ? { label: query.label } : {}),
      sparql: query.sparql,
      error: new WorkshopError('forbidden', 'Authorization denied').toJSON(),
    }));
    const memories = await Promise.all(
      task.memorySlugs.map((slug) => this.memories.get(slug, authorization)),
    );
    // Rehydrate the task after linked content to close revocation races.
    await this.tasks.get(id, authorization);
    return {
      task,
      context,
      memories,
      resolvedAt: this.#clock().toISOString(),
    };
  }
}
