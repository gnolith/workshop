import type { Page } from './tasks.js';
import type { VisibilityScopeV1 } from './authorization.js';

export interface Memory {
  slug: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  installationId: string;
  ownerPrincipalId: string;
  workspaceId: string;
  visibility: VisibilityScopeV1;
  authorizationRevision: number;
}

export interface UpsertMemoryInput {
  description: string;
  content: string;
  expectedUpdatedAt?: string;
  expectedRevision?: number;
  visibility?: VisibilityScopeV1;
}

export interface MemoryFilters {
  text?: string;
  cursor?: string;
  limit?: number;
}

export type MemoryPage = Page<Memory>;
