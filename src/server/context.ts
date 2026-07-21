import type { KnowledgeService } from '../protocol/knowledge.js';
import type { ResolveWorkshopPrincipal } from '../protocol.js';
import type { D1DatabaseLike } from './database.js';
import type { WorkshopLimits } from './limits.js';
import { MemoryService } from './memories.js';
import type { ObserveWorkshop } from './observability.js';
import { PacketService } from './packets.js';
import { SparqlService, type ExecuteSparql } from './sparql.js';
import { TaskService } from './tasks.js';

export interface WorkshopRuntimeOptions {
  db: D1DatabaseLike;
  executeSparql: ExecuteSparql;
  knowledge: KnowledgeService;
  resolvePrincipal: ResolveWorkshopPrincipal;
  limits?: Partial<WorkshopLimits>;
  allowService?: (iri: URL) => boolean | Promise<boolean>;
  observe?: ObserveWorkshop;
  clock?: () => Date;
  createId?: () => string;
  corsOrigin?: string | ((request: Request) => string | null);
}

export interface WorkshopRuntime {
  db: D1DatabaseLike;
  limits?: Partial<WorkshopLimits>;
  tasks: TaskService;
  memories: MemoryService;
  packets: PacketService;
  sparql: SparqlService;
  knowledge: KnowledgeService;
  resolvePrincipal: ResolveWorkshopPrincipal;
  observe?: ObserveWorkshop;
  corsOrigin?: string | ((request: Request) => string | null);
}

export function createWorkshopRuntime(
  options: WorkshopRuntimeOptions,
): WorkshopRuntime {
  const shared = {
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  };
  const memories = new MemoryService(options.db, shared);
  const sparql = new SparqlService({
    execute: options.executeSparql,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.allowService ? { allowService: options.allowService } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  const tasks = new TaskService(options.db, memories, sparql, {
    ...shared,
    ...(options.createId ? { createId: options.createId } : {}),
  });
  return {
    db: options.db,
    ...(options.limits ? { limits: options.limits } : {}),
    tasks,
    memories,
    packets: new PacketService(tasks, memories, sparql, shared),
    sparql,
    knowledge: options.knowledge,
    resolvePrincipal: options.resolvePrincipal,
    ...(options.observe ? { observe: options.observe } : {}),
    ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
  };
}
