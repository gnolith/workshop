import { normalizeWorkshopError } from '../protocol/errors.js';
import type { TaskPacket } from '../protocol/tasks.js';
import type { MemoryService } from './memories.js';
import type { SparqlService } from './sparql.js';
import type { TaskService } from './tasks.js';

export interface PacketServiceOptions {
  clock?: () => Date;
}

export class PacketService {
  readonly #clock: () => Date;

  constructor(
    readonly tasks: TaskService,
    readonly memories: MemoryService,
    readonly sparql: SparqlService,
    options: PacketServiceOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(id: string, signal?: AbortSignal): Promise<TaskPacket> {
    const task = await this.tasks.get(id);
    const context = await Promise.all(
      task.contextQueries.map(async (query) => {
        try {
          const result = await this.sparql.query(query.sparql, {
            ...(signal ? { signal } : {}),
          });
          return {
            ...(query.label ? { label: query.label } : {}),
            sparql: query.sparql,
            result,
          };
        } catch (error) {
          return {
            ...(query.label ? { label: query.label } : {}),
            sparql: query.sparql,
            error: normalizeWorkshopError(error).toJSON(),
          };
        }
      }),
    );
    const memories = await Promise.all(
      task.memorySlugs.map((slug) => this.memories.get(slug)),
    );
    return {
      task,
      context,
      memories,
      resolvedAt: this.#clock().toISOString(),
    };
  }
}
