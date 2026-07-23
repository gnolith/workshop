import type { Memory } from './memories.js';
import type { SparqlQueryResult } from './sparql.js';
import type { WorkshopErrorBody } from './errors.js';
import type { VisibilityScopeV1 } from './authorization.js';

export interface ContextQuery {
  label?: string;
  sparql: string;
}

export type TaskState = 'unclaimed' | 'claimed' | 'completed' | 'archived';

export interface Task {
  id: string;
  title: string;
  objective?: string;
  description: string;
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
  relationships: readonly TaskRelationship[];
  role?: string;
  prompt: string;
  contextQueries: ContextQuery[];
  memorySlugs: string[];
  claimed: boolean;
  claimedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  result?: string;
  outcomeKind?: TaskOutcomeKind;
  assignedPrincipalId?: string;
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

export interface CreateTaskInput {
  idempotencyKey?: string;
  description: string;
  title?: string;
  objective?: string;
  constraints?: readonly string[];
  acceptanceCriteria?: readonly string[];
  relationships?: readonly TaskRelationship[];
  assignedPrincipalId?: string;
  language?: string;
  attribution?: Readonly<Record<string, unknown>>;
  role?: string;
  prompt: string;
  contextQueries?: ContextQuery[];
  memorySlugs?: string[];
  visibility?: VisibilityScopeV1;
}

export interface UpdateTaskPatch {
  title?: string;
  objective?: string | null;
  description?: string;
  constraints?: readonly string[];
  acceptanceCriteria?: readonly string[];
  relationships?: readonly TaskRelationship[];
  assignedPrincipalId?: string | null;
  language?: string;
  attribution?: Readonly<Record<string, unknown>>;
  role?: string | null;
  prompt?: string;
  contextQueries?: ContextQuery[];
  memorySlugs?: string[];
  visibility?: VisibilityScopeV1;
}

export type TaskRevisionPrecondition =
  | { expectedRevision: number; expectedUpdatedAt?: string }
  | { expectedRevision?: undefined; expectedUpdatedAt: string };

export type UpdateTaskInput = UpdateTaskPatch & TaskRevisionPrecondition;

export interface TaskFilters {
  role?: string;
  state?: TaskState;
  claimed?: boolean;
  updatedAfter?: string;
  text?: string;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export type TaskPage = Page<Task>;

export interface TaskRelationship {
  kind:
    | 'duplicate'
    | 'overlaps'
    | 'reuses'
    | 'mergeable'
    | 'splittable'
    | 'blocks'
    | 'related';
  taskId: string;
}

export type TaskOutcomeKind = 'success' | 'negative' | 'inconclusive';

export interface TaskOutcomeInput {
  kind: TaskOutcomeKind;
  result: string;
}

export interface TaskRevision {
  taskId: string;
  revision: number;
  task: Task;
  actorPrincipalId: string;
  eventId: string;
  createdAt: string;
}

/** Bounded history reads return newest canonical revisions first. */
export interface RevisionHistoryOptions {
  limit?: number;
}

export interface TaskPacket {
  task: Task;
  context: Array<{
    label?: string;
    sparql: string;
    result?: SparqlQueryResult;
    error?: WorkshopErrorBody;
  }>;
  memories: Memory[];
  resolvedAt: string;
}

export function taskState(task: Task): TaskState {
  if (task.archivedAt) return 'archived';
  if (task.completedAt) return 'completed';
  if (task.claimed) return 'claimed';
  return 'unclaimed';
}
