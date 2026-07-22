import type { Page } from './tasks.js';
import type { VisibilityScopeV1 } from './authorization.js';

export interface Memory {
  slug: string;
  title: string;
  description: string;
  content: string;
  applicability: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
  language: string;
  attribution: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  revision: number;
  policyRevision: number;
  installationId: string;
  ownerPrincipalId: string;
  workspaceId: string;
  visibility: VisibilityScopeV1;
  authorizationRevision: number;
}

export interface UpsertMemoryInput {
  title?: string;
  description: string;
  content: string;
  applicability?: Readonly<Record<string, unknown>>;
  provenance?: Readonly<Record<string, unknown>>;
  language?: string;
  attribution?: Readonly<Record<string, unknown>>;
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

export interface MemoryRevision {
  memoryId: string;
  revision: number;
  memory: Memory;
  actorPrincipalId: string;
  eventId: string;
  createdAt: string;
}
