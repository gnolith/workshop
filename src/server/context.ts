import type { ResolveWorkshopPrincipal } from '../protocol.js';
import type { D1DatabaseLike, WorkshopPersistence } from './database.js';
import type { WorkshopCursorCodec } from './cursor.js';
import type { WorkshopLimits } from './limits.js';
import { MemoryService } from './memories.js';
import type { ObserveWorkshop } from './observability.js';
import { PacketService } from './packets.js';
import {
  createTaprootKnowledgeService,
  type TaprootKnowledgeOptions,
} from './knowledge.js';
import { ContextQueryValidator } from './sparql.js';
import { TaskService } from './tasks.js';
import type { WorkshopAuthorizationAuthority } from './authorization.js';

export interface WorkshopCoreOptions {
  persistence: WorkshopPersistence;
  authorization: WorkshopAuthorizationAuthority;
  knowledge: Omit<TaprootKnowledgeOptions, 'authorization'>;
  diamondHealth: () => boolean | Promise<boolean>;
  cursorCodec: WorkshopCursorCodec;
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
  knowledge: ReturnType<typeof createTaprootKnowledgeService>;
  authorization: WorkshopAuthorizationAuthority;
  diamondHealth: () => boolean | Promise<boolean>;
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
  const memories = new MemoryService(options.persistence, {
    ...shared,
    authorization: options.authorization,
    cursorCodec: options.cursorCodec,
  });
  const queryValidator = new ContextQueryValidator({
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.allowService ? { allowService: options.allowService } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  const tasks = new TaskService(options.persistence, memories, queryValidator, {
    ...shared,
    authorization: options.authorization,
    cursorCodec: options.cursorCodec,
    ...(options.createId ? { createId: options.createId } : {}),
  });
  const knowledge = createTaprootKnowledgeService({
    ...options.knowledge,
    authorization: options.authorization,
  });
  return {
    persistence: options.persistence,
    ...(options.limits ? { limits: options.limits } : {}),
    tasks,
    memories,
    packets: new PacketService(tasks, memories, shared),
    knowledge,
    authorization: options.authorization,
    diamondHealth: options.diamondHealth,
    ...(options.observe ? { observe: options.observe } : {}),
  };
}

export function createWorkshopRuntime(
  options: WorkshopRuntimeOptions,
): WorkshopRuntime {
  const core = createWorkshopCore({
    persistence: options.db,
    authorization: options.authorization,
    knowledge: options.knowledge,
    diamondHealth: options.diamondHealth,
    cursorCodec: options.cursorCodec,
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
