import type { VisibilityScopeV1 } from './authorization.js';
import type { Page } from './tasks.js';

export interface PromptAttribution {
  source?: string;
  actor?: string;
  note?: string;
}

export interface Prompt {
  id: string;
  name: string;
  title: string;
  promptText: string;
  scope?: string;
  role?: string;
  variables: Readonly<Record<string, unknown>>;
  active: boolean;
  priority: number;
  order: number;
  language: string;
  attribution: PromptAttribution;
  revision: number;
  policyRevision: number;
  installationId: string;
  ownerPrincipalId: string;
  workspaceId: string;
  visibility: VisibilityScopeV1;
  authorizationRevision: number;
  createdAt: string;
  updatedAt: string;
  deactivatedAt?: string;
}

export interface CreatePromptInput {
  id?: string;
  name: string;
  title?: string;
  promptText: string;
  scope?: string;
  role?: string;
  variables?: Readonly<Record<string, unknown>>;
  active?: boolean;
  priority?: number;
  order?: number;
  language?: string;
  attribution?: PromptAttribution;
  visibility?: VisibilityScopeV1;
}

export interface UpdatePromptPatch {
  name?: string;
  title?: string;
  promptText?: string;
  scope?: string | null;
  role?: string | null;
  variables?: Readonly<Record<string, unknown>>;
  active?: boolean;
  priority?: number;
  order?: number;
  language?: string;
  attribution?: PromptAttribution;
  visibility?: VisibilityScopeV1;
}

export type UpdatePromptInput = UpdatePromptPatch & {
  expectedRevision: number;
};

export interface PromptFilters {
  text?: string;
  active?: boolean;
  role?: string;
  scope?: string;
  cursor?: string;
  limit?: number;
}

export type PromptPage = Page<Prompt>;

export interface PromptRevision {
  promptId: string;
  revision: number;
  prompt: Prompt;
  actorPrincipalId: string;
  eventId: string;
  createdAt: string;
}
