import type { KnowledgeService } from '../protocol/knowledge.js';
import type { ResolveWorkshopPrincipal } from '../protocol.js';
import type { D1DatabaseLike, WorkshopPersistence } from './database.js';
import type { WorkshopLimits } from './limits.js';
import { MemoryService } from './memories.js';
import type { ObserveWorkshop } from './observability.js';
import { PacketService } from './packets.js';
import { SparqlService, type ExecuteSparql } from './sparql.js';
import { TaskService } from './tasks.js';

export interface WorkshopCoreOptions {
  persistence: WorkshopPersistence;
  executeSparql: ExecuteSparql;
  knowledge: KnowledgeService;
  limits?: Partial<WorkshopLimits>;
  allowService?: (iri: URL) => boolean | Promise<boolean>;
  observe?: ObserveWorkshop;
  clock?: () => Date;
  createId?: () => string;
}

export interface WorkshopCore {
  persistence: WorkshopPersistence;
  limits?: Partial<WorkshopLimits>;
  tasks: TaskService;
  memories: MemoryService;
  packets: PacketService;
  sparql: SparqlService;
  knowledge: KnowledgeService;
  observe?: ObserveWorkshop;
}

export interface WorkshopRuntimeOptions extends Omit<
  WorkshopCoreOptions,
  'persistence'
> {
  db: D1DatabaseLike;
  resolvePrincipal: ResolveWorkshopPrincipal;
  corsOrigin?: string | ((request: Request) => string | null);
}

export interface WorkshopRuntime extends WorkshopCore {
  db: D1DatabaseLike;
  resolvePrincipal: ResolveWorkshopPrincipal;
  corsOrigin?: string | ((request: Request) => string | null);
}

export function createWorkshopCore(options: WorkshopCoreOptions): WorkshopCore {
  const shared = {
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  };
  const memories = new MemoryService(options.persistence, shared);
  const sparql = new SparqlService({
    execute: options.executeSparql,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.allowService ? { allowService: options.allowService } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  const tasks = new TaskService(options.persistence, memories, sparql, {
    ...shared,
    ...(options.createId ? { createId: options.createId } : {}),
  });
  return {
    persistence: options.persistence,
    ...(options.limits ? { limits: options.limits } : {}),
    tasks,
    memories,
    packets: new PacketService(tasks, memories, sparql, shared),
    sparql,
    knowledge: options.knowledge,
    ...(options.observe ? { observe: options.observe } : {}),
  };
}

export function createWorkshopRuntime(
  options: WorkshopRuntimeOptions,
): WorkshopRuntime {
  const core = createWorkshopCore({
    persistence: options.db,
    executeSparql: options.executeSparql,
    knowledge: options.knowledge,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.allowService ? { allowService: options.allowService } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
  });
  return {
    ...core,
    db: options.db,
    resolvePrincipal: options.resolvePrincipal,
    ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
  };
}
