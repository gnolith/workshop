export * from './protocol/errors.js';
export * from './protocol/tasks.js';
export * from './protocol/memories.js';
export * from './protocol/prompts.js';
export * from './protocol/knowledge.js';
export * from './protocol/client.js';
export * from './protocol/authorization.js';
import type { AuthorizationContext } from './protocol/authorization.js';

export type WorkshopCapability =
  | 'read'
  | 'task-write'
  | 'knowledge-write'
  | 'memory-write'
  | 'prompt-write'
  | 'admin'
  | 'search:admin';

/** @deprecated Name retained for transport resolver compatibility. */
export type WorkshopPrincipal = AuthorizationContext;

export function hasWorkshopCapability(
  capabilities: readonly string[],
  capability: WorkshopCapability,
): boolean {
  return capabilities.includes(capability);
}

export type ResolveWorkshopPrincipal = (
  request: Request,
) => Promise<WorkshopPrincipal | null>;
