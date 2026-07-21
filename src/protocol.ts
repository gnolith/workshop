export * from './protocol/errors.js';
export * from './protocol/tasks.js';
export * from './protocol/memories.js';
export * from './protocol/sparql.js';
export * from './protocol/knowledge.js';
export * from './protocol/onboarding.js';
export * from './protocol/client.js';

export type WorkshopCapability =
  'read' | 'task-write' | 'knowledge-write' | 'memory-write' | 'admin';

export interface WorkshopPrincipal {
  id: string;
  capabilities: readonly WorkshopCapability[];
}

export type ResolveWorkshopPrincipal = (
  request: Request,
) => Promise<WorkshopPrincipal | null>;
