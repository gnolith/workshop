export * from './protocol/errors.js';
export * from './protocol/tasks.js';
export * from './protocol/memories.js';
export * from './protocol/prompts.js';
export * from './protocol/knowledge.js';
export * from './protocol/client.js';
export * from './protocol/catalog.js';
export * from './protocol/authorization.js';
import type { AuthorizationContext } from './protocol/authorization.js';

export type WorkshopCapability =
  | 'read'
  | 'task:write'
  | 'knowledge:write'
  | 'knowledge:policy'
  | 'memory:write'
  | 'prompt:write'
  | 'admin'
  | 'search:admin';

export interface AuthenticatedPrincipal {
  installationId: string;
  principalId: string;
  activeWorkspaceId: string | null;
  /**
   * Populated only after Taproot's live authorization recheck. Transport
   * authentication alone does not establish workspace membership.
   */
  workspaceIds?: readonly string[];
  capabilities: readonly string[];
  authorizationRevision: number;
  credentialId: string;
}

/** Internal authorization context after the live server-side membership fence. */
export interface WorkshopPrincipal extends AuthorizationContext {
  /** Present on transport-authenticated principals; legacy process-local callers omit it. */
  credentialId?: string;
}

export function hasWorkshopCapability(
  capabilities: readonly string[],
  capability: WorkshopCapability,
): boolean {
  return capabilities.includes(capability);
}

export type ResolveWorkshopPrincipal = (
  request: Request,
) => Promise<WorkshopPrincipal | null>;
