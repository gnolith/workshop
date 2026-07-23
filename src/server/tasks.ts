import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type {
  ContextQuery,
  CreateTaskInput,
  Task,
  TaskFilters,
  TaskPage,
  TaskOutcomeInput,
  TaskOutcomeKind,
  TaskRelationship,
  TaskRevision,
  RevisionHistoryOptions,
  UpdateTaskInput,
} from '../protocol/tasks.js';
import {
  assertCursorCandidatesBounded,
  createCursorSnapshot,
  encodeCursor,
  openCursorSnapshot,
  readCursorEntries,
  requireUnchangedCursorState,
  type CursorBinding,
  type WorkshopCursorCodec,
} from './cursor.js';
import type { D1DatabaseLike } from './database.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { MemoryService } from './memories.js';
import type { ObserveWorkshop, WorkshopOperation } from './observability.js';
import { observed } from './observability.js';
import {
  authorizeRecord,
  defaultVisibility,
  denied,
  normalizeVisibilityScope,
  requireCapability,
  requireActiveWorkspace,
  requireCurrentAuthorization,
  serializeVisibilityScope,
  visibilitySql,
  type AuthorizationContext,
  type VisibilityScopeV1,
  type WorkshopAuthorizationAuthority,
} from './authorization.js';
import type { ContextQueryValidator } from './sparql.js';
import {
  commitWorkshopCanonicalSearchMutationV1,
  type WorkshopSearchDomainV1,
} from './search.js';
import {
  contextQueries,
  isoDate,
  memorySlugs,
  optionalText,
  pageLimit,
  requiredText,
  validation,
} from './validation.js';

interface TaskRow {
  id: string;
  title: string | null;
  objective: string | null;
  idempotency_key: string | null;
  description: string;
  constraints_json: string;
  acceptance_criteria_json: string;
  relationships_json: string;
  assigned_principal_id: string | null;
  outcome_kind: string | null;
  language: string;
  attribution_json: string;
  role: string | null;
  prompt: string;
  context_queries: string;
  memory_slugs: string;
  claimed: number;
  claimed_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  policy_revision: number;
  installation_id: string | null;
  owner_principal_id: string | null;
  workspace_id: string | null;
  visibility_scope: string | null;
  authorization_revision: number | null;
  search_event_id: string | null;
  search_event_sequence: number | null;
}

const AUTHORIZED_ID_BATCH = 80;

export interface TaskServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  createId?: () => string;
  observe?: ObserveWorkshop;
  authorization: WorkshopAuthorizationAuthority;
  cursorCodec: WorkshopCursorCodec;
  search?: WorkshopSearchDomainV1;
}

export class TaskService {
  readonly #limits: WorkshopLimits;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    readonly db: D1DatabaseLike,
    readonly memories: MemoryService,
    readonly queryValidator: ContextQueryValidator,
    private readonly options: TaskServiceOptions,
  ) {
    if (!options.authorization || !options.cursorCodec) throw denied();
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async get(id: string, authorization: AuthorizationContext): Promise<Task> {
    const context = await this.#context(authorization);
    const row = await this.#getRow(id, context);
    if (!row) throw denied();
    const task = toTask(row);
    await this.#recheck(row, context);
    return task;
  }

  async list(
    filters: TaskFilters = {},
    authorization: AuthorizationContext,
  ): Promise<TaskPage> {
    const limit = pageLimit(filters.limit, this.#limits);
    const context = await this.#context(authorization);
    const updatedAfter = filters.updatedAfter
      ? isoDate(filters.updatedAfter, 'updatedAfter')
      : null;
    const textFilter = filters.text?.trim() || null;
    const binding: CursorBinding = {
      operation: 'task.query',
      domain: 'task',
      query: 'updated_at_desc__id_asc.v1',
      filters: {
        role: filters.role ?? null,
        state: filters.state ?? null,
        claimed: filters.claimed ?? null,
        updatedAfter,
        text: textFilter,
        limit,
      },
    };
    const visibility = visibilitySql('workshop_tasks', context);
    const clauses: string[] = [visibility.sql];
    const values: unknown[] = [...visibility.values];
    if (filters.role) {
      clauses.push('role = ?');
      values.push(filters.role);
    }
    if (filters.claimed !== undefined) {
      clauses.push('claimed = ?');
      values.push(filters.claimed ? 1 : 0);
    }
    if (updatedAfter) {
      clauses.push('updated_at >= ?');
      values.push(updatedAfter);
    }
    if (textFilter) {
      clauses.push(
        "(description LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeLike(textFilter)}%`;
      values.push(pattern, pattern);
    }
    switch (filters.state) {
      case 'archived':
        clauses.push('archived_at IS NOT NULL');
        break;
      case 'completed':
        clauses.push('archived_at IS NULL AND completed_at IS NOT NULL');
        break;
      case 'claimed':
        clauses.push(
          'archived_at IS NULL AND completed_at IS NULL AND claimed = 1',
        );
        break;
      case 'unclaimed':
        clauses.push(
          'archived_at IS NULL AND completed_at IS NULL AND claimed = 0',
        );
        break;
    }
    let snapshot;
    if (filters.cursor) {
      snapshot = await openCursorSnapshot(
        this.db,
        this.options.authorization,
        this.options.cursorCodec,
        filters.cursor,
        binding,
        context,
        this.#clock(),
      );
    } else {
      const candidates = await this.db
        .prepare(
          `SELECT id, revision, updated_at FROM workshop_tasks
           WHERE ${clauses.join(' AND ')}
           ORDER BY updated_at DESC, id ASC LIMIT 1001`,
        )
        .bind(...values)
        .all<{ id: string; revision: number; updated_at: string }>();
      assertCursorCandidatesBounded(candidates.results.length);
      if (candidates.results.length === 0) return { items: [], cursor: null };
      snapshot = await createCursorSnapshot(
        this.db,
        this.options.authorization,
        this.options.cursorCodec,
        binding,
        context,
        candidates.results.map((row) => ({
          id: row.id,
          revision: row.revision,
          updatedAt: normalizeDate(row.updated_at),
        })),
        limit,
        this.#clock(),
      );
    }
    const entries = await readCursorEntries(this.db, snapshot, limit);
    const hydrated: TaskRow[] = [];
    for (
      let offset = 0;
      offset < entries.length;
      offset += AUTHORIZED_ID_BATCH
    ) {
      const batch = entries.slice(offset, offset + AUTHORIZED_ID_BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const result = await this.db
        .prepare(
          `SELECT * FROM workshop_tasks
           WHERE id IN (${placeholders}) AND ${visibility.sql}`,
        )
        .bind(...batch.map(({ id }) => id), ...visibility.values)
        .all<TaskRow>();
      hydrated.push(...result.results);
    }
    const byId = new Map(hydrated.map((row) => [row.id, row]));
    const rows = entries.map((entry) => {
      const row = byId.get(entry.id);
      if (
        !row ||
        row.revision !== entry.revision ||
        normalizeDate(row.updated_at) !== entry.updatedAt
      )
        throw denied();
      return row;
    });
    await this.#recheckAll(rows, context);
    await requireUnchangedCursorState(
      this.options.authorization,
      context,
      snapshot.state,
    );
    const visible = rows.slice(0, limit);
    return {
      items: visible.map(toTask),
      cursor:
        rows.length > limit
          ? await encodeCursor(
              this.options.cursorCodec,
              snapshot,
              snapshot.start + limit,
            )
          : null,
    };
  }

  search(
    filters: TaskFilters = {},
    authorization: AuthorizationContext,
  ): Promise<TaskPage> {
    return this.list(filters, authorization);
  }

  async create(
    input: CreateTaskInput,
    authorization: AuthorizationContext,
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const workspaceId = requireActiveWorkspace(context);
    const scope = normalizeVisibilityScope(
      input.visibility ?? defaultVisibility(context),
    );
    const idempotencyKey = optionalText(
      input.idempotencyKey,
      'idempotencyKey',
      256,
    );
    const storedIdempotencyKey = idempotencyKey
      ? `${context.installationId}\u0000${workspaceId}\u0000${context.principalId}\u0000${idempotencyKey}`
      : undefined;
    const normalized = await this.#validateInput(input, context);
    if (storedIdempotencyKey) {
      const predicate = visibilitySql('workshop_tasks', context);
      const existing = await this.db
        .prepare(
          `SELECT * FROM workshop_tasks WHERE idempotency_key = ? AND ${predicate.sql}`,
        )
        .bind(storedIdempotencyKey, ...predicate.values)
        .first<TaskRow>();
      if (existing) {
        await this.#recheck(existing, context);
        return idempotentTask(existing, { ...normalized, visibility: scope });
      }
    }
    const id = this.#createId();
    const now = this.#clock().toISOString();
    return this.#mutation('task.create', context.principalId, id, async () => {
      try {
        const eventId = crypto.randomUUID();
        const next: Task = {
          id,
          ...normalized,
          claimed: false,
          createdAt: now,
          updatedAt: now,
          revision: 1,
          policyRevision: 1,
          installationId: context.installationId,
          ownerPrincipalId: context.principalId,
          workspaceId,
          visibility: scope,
          authorizationRevision: context.authorizationRevision,
        };
        const row = await this.#commitCanonical(
          context,
          next,
          'task.create',
          null,
          {
            sql: `INSERT INTO workshop_tasks
             (id, idempotency_key, title, objective, description, constraints_json,
              acceptance_criteria_json, relationships_json, assigned_principal_id, language,
              attribution_json, role, prompt, context_queries, memory_slugs, claimed,
              created_at, updated_at, installation_id, owner_principal_id, workspace_id,
              visibility_scope, authorization_revision, policy_revision,
              search_event_id, search_event_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL) RETURNING *`,
            values: [
              id,
              storedIdempotencyKey ?? null,
              normalized.title,
              normalized.objective ?? null,
              normalized.description,
              JSON.stringify(normalized.constraints),
              JSON.stringify(normalized.acceptanceCriteria),
              JSON.stringify(normalized.relationships),
              normalized.assignedPrincipalId ?? null,
              normalized.language,
              JSON.stringify(normalized.attribution),
              normalized.role ?? null,
              normalized.prompt,
              JSON.stringify(normalized.contextQueries),
              JSON.stringify(normalized.memorySlugs),
              now,
              now,
              context.installationId,
              context.principalId,
              workspaceId,
              serializeVisibilityScope(scope),
              context.authorizationRevision,
              eventId,
            ],
          },
          eventId,
        );
        if (!row)
          throw new WorkshopError('internal_error', 'Task creation failed');
        authorizeRecord(toAuthorizationRecord(row), context);
        return toTask(row);
      } catch (error) {
        if (storedIdempotencyKey && isUniqueError(error)) {
          const predicate = visibilitySql('workshop_tasks', context);
          const existing = await this.db
            .prepare(
              `SELECT * FROM workshop_tasks WHERE idempotency_key = ? AND ${predicate.sql}`,
            )
            .bind(storedIdempotencyKey, ...predicate.values)
            .first<TaskRow>();
          if (existing) {
            await this.#recheck(existing, context);
            return idempotentTask(existing, {
              ...normalized,
              visibility: scope,
            });
          }
          throw denied();
        }
        throw error;
      }
    });
  }

  async update(
    id: string,
    input: UpdateTaskInput,
    authorization: AuthorizationContext,
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const current = await this.#getForMutation(id, context);
    if (current.completedAt || current.archivedAt) {
      throw new WorkshopError(
        'conflict',
        'Completed or archived tasks cannot be reopened or edited',
      );
    }
    const expected = revisionPrecondition(input);
    const description =
      input.description === undefined
        ? current.description
        : requiredText(
            input.description,
            'description',
            this.#limits.maxDescriptionBytes,
          );
    const title =
      input.title === undefined
        ? current.title
        : requiredText(input.title, 'title', this.#limits.maxDescriptionBytes);
    const objective =
      input.objective === null
        ? undefined
        : input.objective === undefined
          ? current.objective
          : requiredText(
              input.objective,
              'objective',
              this.#limits.maxDescriptionBytes,
            );
    const constraints =
      input.constraints === undefined
        ? current.constraints
        : stringList(
            input.constraints,
            'constraints',
            100,
            this.#limits.maxDescriptionBytes,
          );
    const acceptanceCriteria =
      input.acceptanceCriteria === undefined
        ? current.acceptanceCriteria
        : stringList(
            input.acceptanceCriteria,
            'acceptanceCriteria',
            100,
            this.#limits.maxDescriptionBytes,
          );
    const relationships =
      input.relationships === undefined
        ? current.relationships
        : relationshipList(input.relationships);
    const assignedPrincipalId =
      input.assignedPrincipalId === null
        ? undefined
        : input.assignedPrincipalId === undefined
          ? current.assignedPrincipalId
          : requiredText(input.assignedPrincipalId, 'assignedPrincipalId', 256);
    const language =
      input.language === undefined
        ? current.language
        : requiredText(input.language, 'language', 64);
    const attribution =
      input.attribution === undefined
        ? current.attribution
        : jsonObject(
            input.attribution,
            'attribution',
            this.#limits.maxDescriptionBytes,
          );
    const role =
      input.role === null
        ? undefined
        : input.role === undefined
          ? current.role
          : optionalText(input.role, 'role', 256);
    const prompt =
      input.prompt === undefined
        ? current.prompt
        : requiredText(input.prompt, 'prompt', this.#limits.maxPromptBytes);
    const queries =
      input.contextQueries === undefined
        ? current.contextQueries
        : contextQueries(input.contextQueries, this.#limits);
    const slugs =
      input.memorySlugs === undefined
        ? current.memorySlugs
        : memorySlugs(input.memorySlugs, this.#limits);
    if (input.contextQueries !== undefined)
      await this.#validateQueries(queries);
    if (input.memorySlugs !== undefined)
      await this.memories.requireAll(slugs, context);
    const scope = normalizeVisibilityScope(
      input.visibility ?? current.visibility,
    );
    if (
      input.visibility &&
      current.ownerPrincipalId !== context.principalId &&
      !context.capabilities.includes('admin')
    )
      throw denied();
    const predicate = visibilitySql('workshop_tasks', context);
    const now = this.#clock().toISOString();
    return this.#mutation('task.update', context.principalId, id, async () => {
      const policyChanged =
        serializeVisibilityScope(scope) !==
        serializeVisibilityScope(current.visibility);
      const {
        objective: _currentObjective,
        assignedPrincipalId: _currentAssignee,
        role: _currentRole,
        ...currentRequired
      } = current;
      void _currentObjective;
      void _currentAssignee;
      void _currentRole;
      const next: Task = {
        ...currentRequired,
        title,
        ...(objective ? { objective } : {}),
        description,
        constraints,
        acceptanceCriteria,
        relationships,
        ...(assignedPrincipalId ? { assignedPrincipalId } : {}),
        language,
        attribution,
        ...(role ? { role } : {}),
        prompt,
        contextQueries: queries,
        memorySlugs: slugs,
        visibility: scope,
        revision: current.revision + 1,
        policyRevision: current.policyRevision + (policyChanged ? 1 : 0),
        authorizationRevision: context.authorizationRevision,
        updatedAt: nextTimestamp(now, current.updatedAt),
      };
      const eventId = crypto.randomUUID();
      const row = await this.#commitCanonical(
        context,
        next,
        policyChanged ? 'task.policy' : 'task.update',
        await this.#predecessor(id, context),
        {
          sql: `UPDATE workshop_tasks
           SET title = ?, objective = ?, description = ?, constraints_json = ?,
               acceptance_criteria_json = ?, relationships_json = ?, assigned_principal_id = ?,
               language = ?, attribution_json = ?, role = ?, prompt = ?, context_queries = ?, memory_slugs = ?,
               visibility_scope = ?, authorization_revision = ?, policy_revision = ?,
               revision = ?, updated_at = ?, search_event_id = ?, search_event_sequence = NULL
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql}
           RETURNING *`,
          values: [
            title,
            objective ?? null,
            description,
            JSON.stringify(constraints),
            JSON.stringify(acceptanceCriteria),
            JSON.stringify(relationships),
            assignedPrincipalId ?? null,
            language,
            JSON.stringify(attribution),
            role ?? null,
            prompt,
            JSON.stringify(queries),
            JSON.stringify(slugs),
            serializeVisibilityScope(scope),
            context.authorizationRevision,
            next.policyRevision,
            next.revision,
            next.updatedAt,
            eventId,
            id,
            expected.value,
            ...predicate.values,
          ],
        },
        eventId,
      );
      if (!row) {
        if (!(await this.#getRow(id, await this.#context(context))))
          throw denied();
        throw new WorkshopError(
          'conflict',
          `Task ${id} changed state or was updated since it was read`,
        );
      }
      authorizeRecord(toAuthorizationRecord(row), context);
      return toTask(row);
    });
  }

  async archive(
    id: string,
    options: {
      expectedRevision?: number;
      expectedUpdatedAt?: string;
    },
    authorization: AuthorizationContext,
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const current = await this.#getForMutation(id, context);
    const predicate = visibilitySql('workshop_tasks', context);
    const expected = revisionPrecondition(options);
    const now = this.#clock().toISOString();
    return this.#mutation('task.archive', context.principalId, id, async () => {
      const eventId = crypto.randomUUID();
      const next: Task = {
        ...current,
        claimed: false,
        archivedAt: nextTimestamp(now, current.updatedAt),
        revision: current.revision + 1,
        updatedAt: nextTimestamp(now, current.updatedAt),
        authorizationRevision: context.authorizationRevision,
      };
      const row = await this.#commitCanonical(
        context,
        next,
        'task.state',
        await this.#predecessor(id, context),
        {
          sql: `UPDATE workshop_tasks SET archived_at = ?, claimed = 0, claimed_at = NULL,
             revision = ?, authorization_revision = ?, updated_at = ?,
             search_event_id = ?, search_event_sequence = NULL
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
             AND (claimed = 0 OR ? = 1) AND ${predicate.sql} RETURNING *`,
          values: [
            next.archivedAt,
            next.revision,
            context.authorizationRevision,
            next.updatedAt,
            eventId,
            id,
            expected.value,
            context.capabilities.includes('admin') ? 1 : 0,
            ...predicate.values,
          ],
        },
        eventId,
      );
      if (!row) {
        if (!(await this.#getRow(id, await this.#context(context))))
          throw denied();
        throw new WorkshopError('conflict', 'Task state changed');
      }
      authorizeRecord(toAuthorizationRecord(row), context);
      return toTask(row);
    });
  }

  async claim(id: string, authorization: AuthorizationContext): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const current = await this.#getForMutation(id, context);
    const predicate = visibilitySql('workshop_tasks', context);
    const now = this.#clock().toISOString();
    return this.#mutation('task.claim', context.principalId, id, async () => {
      const eventId = crypto.randomUUID();
      const next: Task = {
        ...current,
        claimed: true,
        claimedAt: nextTimestamp(now, current.updatedAt),
        revision: current.revision + 1,
        updatedAt: nextTimestamp(now, current.updatedAt),
        authorizationRevision: context.authorizationRevision,
      };
      const row = await this.#commitCanonical(
        context,
        next,
        'task.state',
        await this.#predecessor(id, context),
        {
          sql: `UPDATE workshop_tasks SET claimed = 1, claimed_at = ?,
             revision = ?, authorization_revision = ?, updated_at = ?,
             search_event_id = ?, search_event_sequence = NULL
           WHERE id = ? AND revision = ? AND claimed = 0 AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
          values: [
            next.claimedAt,
            next.revision,
            context.authorizationRevision,
            next.updatedAt,
            eventId,
            id,
            current.revision,
            ...predicate.values,
          ],
        },
        eventId,
      );
      if (!row) {
        if (!(await this.#getRow(id, await this.#context(context))))
          throw denied();
        throw new WorkshopError('conflict', 'Task state changed');
      }
      authorizeRecord(toAuthorizationRecord(row), context);
      return toTask(row);
    });
  }

  async complete(
    id: string,
    resultValue: unknown,
    authorization: AuthorizationContext,
    retryOnConcurrentEdit = true,
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const current = await this.#getForMutation(id, context);
    const predicate = visibilitySql('workshop_tasks', context);
    const outcome = normalizeOutcome(resultValue);
    const result = requiredText(
      outcome.result,
      'result',
      this.#limits.maxResultBytes,
    );
    const now = this.#clock().toISOString();
    return this.#mutation(
      'task.complete',
      context.principalId,
      id,
      async () => {
        const eventId = crypto.randomUUID();
        const { claimedAt: _claimedAt, ...withoutClaimedAt } = current;
        void _claimedAt;
        const next: Task = {
          ...withoutClaimedAt,
          claimed: false,
          completedAt: nextTimestamp(now, current.updatedAt),
          result,
          outcomeKind: outcome.kind,
          revision: current.revision + 1,
          updatedAt: nextTimestamp(now, current.updatedAt),
          authorizationRevision: context.authorizationRevision,
        };
        let row: TaskRow | null;
        try {
          row = await this.#commitCanonical(
            context,
            next,
            'task.state',
            await this.#predecessor(id, context),
            {
              sql: `UPDATE workshop_tasks
           SET claimed = 0, claimed_at = NULL, completed_at = ?, result = ?, outcome_kind = ?,
               revision = ?, authorization_revision = ?, updated_at = ?,
               search_event_id = ?, search_event_sequence = NULL
           WHERE id = ? AND revision = ? AND claimed = 1 AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
              values: [
                next.completedAt,
                result,
                outcome.kind,
                next.revision,
                context.authorizationRevision,
                next.updatedAt,
                eventId,
                id,
                current.revision,
                ...predicate.values,
              ],
            },
            eventId,
          );
        } catch (error) {
          const retried = await this.#retryCompletion(
            id,
            resultValue,
            context,
            current.revision,
            retryOnConcurrentEdit,
          );
          if (retried) return retried;
          throw error;
        }
        if (!row) {
          const retried = await this.#retryCompletion(
            id,
            resultValue,
            context,
            current.revision,
            retryOnConcurrentEdit,
          );
          if (retried) return retried;
          if (!(await this.#getRow(id, context))) throw denied();
          throw new WorkshopError('conflict', 'Task state changed');
        }
        authorizeRecord(toAuthorizationRecord(row), context);
        return toTask(row);
      },
    );
  }

  async resetAbandonedClaim(
    id: string,
    claimedBefore: string,
    authorization: AuthorizationContext,
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    requireCapability(context, 'admin');
    const current = await this.#getForMutation(id, context);
    const predicate = visibilitySql('workshop_tasks', context);
    const cutoff = isoDate(claimedBefore, 'claimedBefore');
    const now = this.#clock().toISOString();
    return this.#mutation(
      'task.reset-claim',
      context.principalId,
      id,
      async () => {
        const eventId = crypto.randomUUID();
        const { claimedAt: _claimedAt, ...withoutClaimedAt } = current;
        void _claimedAt;
        const next: Task = {
          ...withoutClaimedAt,
          claimed: false,
          revision: current.revision + 1,
          updatedAt: nextTimestamp(now, current.updatedAt),
          authorizationRevision: context.authorizationRevision,
        };
        const row = await this.#commitCanonical(
          context,
          next,
          'task.state',
          await this.#predecessor(id, context),
          {
            sql: `UPDATE workshop_tasks SET claimed = 0, claimed_at = NULL,
             revision = ?, authorization_revision = ?, updated_at = ?,
             search_event_id = ?, search_event_sequence = NULL
           WHERE id = ? AND revision = ? AND claimed = 1 AND claimed_at < ? AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
            values: [
              next.revision,
              context.authorizationRevision,
              next.updatedAt,
              eventId,
              id,
              current.revision,
              cutoff,
              ...predicate.values,
            ],
          },
          eventId,
        );
        if (!row) {
          throw new WorkshopError(
            'conflict',
            `Task ${id} has no abandoned claim before the supplied cutoff`,
          );
        }
        authorizeRecord(toAuthorizationRecord(row), context);
        return toTask(row);
      },
    );
  }

  async history(
    id: string,
    authorization: AuthorizationContext,
    options: RevisionHistoryOptions = {},
  ): Promise<TaskRevision[]> {
    const context = await this.#context(authorization);
    const current = await this.#getRow(id, context);
    if (!current) throw denied();
    await this.#recheck(current, context);
    const limit = pageLimit(
      options.limit ?? this.#limits.maxPageSize,
      this.#limits,
    );
    const rows = await this.db
      .prepare(
        `SELECT task_id, revision, snapshot_json, actor_principal_id, event_id, created_at
         FROM workshop_task_revisions WHERE task_id = ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(current.id, limit)
      .all<{
        task_id: string;
        revision: number;
        snapshot_json: string;
        actor_principal_id: string;
        event_id: string;
        created_at: string;
      }>();
    const revisions = rows.results.map((row, index) => {
      const task = parseTaskRevision(
        row.snapshot_json,
        row.task_id,
        row.revision,
      );
      if (row.revision !== current.revision - index) throw denied();
      authorizeRecord(task, context);
      return {
        taskId: row.task_id,
        revision: row.revision,
        task,
        actorPrincipalId: row.actor_principal_id,
        eventId: row.event_id,
        createdAt: normalizeDate(row.created_at),
      };
    });
    if (revisions.length === 0 || revisions[0]?.revision !== current.revision)
      throw denied();
    await this.#recheck(current, context);
    return revisions;
  }

  async #predecessor(
    id: string,
    context: AuthorizationContext,
  ): Promise<{ eventId: string; sequence: number }> {
    const row = await this.db
      .prepare(
        `SELECT current_event_id AS event_id, current_event_sequence AS sequence
         FROM taproot_unified_search_source_registry
         WHERE installation_id = ? AND source_kind = 'task' AND source_id = ?`,
      )
      .bind(context.installationId, id)
      .first<{ event_id: string; sequence: number }>();
    if (!row || !Number.isSafeInteger(Number(row.sequence))) throw denied();
    return { eventId: row.event_id, sequence: Number(row.sequence) };
  }

  async #commitCanonical(
    context: AuthorizationContext,
    next: Task,
    changeClass: string,
    predecessor: { eventId: string; sequence: number } | null,
    mutation: { sql: string; values: readonly unknown[] },
    eventId: string,
  ): Promise<TaskRow | null> {
    if (!this.options.search)
      throw new WorkshopError(
        'internal_error',
        'Canonical Task search producer is not registered',
      );
    const receipt = await commitWorkshopCanonicalSearchMutationV1(
      this.options.search,
      {
        context,
        eventId,
        sourceId: next.id,
        operation: 'upsert',
        changeClass,
        sourceRevision: next.revision,
        sourcePolicyRevision: next.policyRevision,
        predecessor,
        canonicalPostState: next,
        statements: [
          mutation,
          {
            sql: `INSERT INTO workshop_task_revisions
              (task_id, revision, snapshot_json, actor_principal_id, event_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
            values: [
              next.id,
              next.revision,
              JSON.stringify(next),
              context.principalId,
              eventId,
              next.updatedAt,
            ],
          },
        ],
      },
    );
    return (receipt.results[0]?.results[0] as TaskRow | undefined) ?? null;
  }

  async #validateInput(
    input: CreateTaskInput,
    authorization?: AuthorizationContext,
  ): Promise<{
    title: string;
    objective?: string;
    description: string;
    constraints: string[];
    acceptanceCriteria: string[];
    relationships: TaskRelationship[];
    assignedPrincipalId?: string;
    language: string;
    attribution: Record<string, unknown>;
    role?: string;
    prompt: string;
    contextQueries: ContextQuery[];
    memorySlugs: string[];
  }> {
    if (!input || typeof input !== 'object')
      throw validation('Task input is required');
    const description = requiredText(
      input.description,
      'description',
      this.#limits.maxDescriptionBytes,
    );
    const title = requiredText(
      input.title ?? description,
      'title',
      this.#limits.maxDescriptionBytes,
    );
    const objective = optionalText(
      input.objective,
      'objective',
      this.#limits.maxDescriptionBytes,
    );
    const constraints = stringList(
      input.constraints ?? [],
      'constraints',
      100,
      this.#limits.maxDescriptionBytes,
    );
    const acceptanceCriteria = stringList(
      input.acceptanceCriteria ?? [],
      'acceptanceCriteria',
      100,
      this.#limits.maxDescriptionBytes,
    );
    const relationships = relationshipList(input.relationships ?? []);
    const assignedPrincipalId = optionalText(
      input.assignedPrincipalId,
      'assignedPrincipalId',
      256,
    );
    const language = requiredText(input.language ?? 'en', 'language', 64);
    const attribution = jsonObject(
      input.attribution ?? {},
      'attribution',
      this.#limits.maxDescriptionBytes,
    );
    const role = optionalText(input.role, 'role', 256);
    const prompt = requiredText(
      input.prompt,
      'prompt',
      this.#limits.maxPromptBytes,
    );
    const queries = contextQueries(input.contextQueries, this.#limits);
    const slugs = memorySlugs(input.memorySlugs, this.#limits);
    await this.#validateQueries(queries);
    if (authorization) await this.memories.requireAll(slugs, authorization);
    return {
      description,
      title,
      ...(objective ? { objective } : {}),
      constraints,
      acceptanceCriteria,
      relationships,
      ...(assignedPrincipalId ? { assignedPrincipalId } : {}),
      language,
      attribution,
      ...(role ? { role } : {}),
      prompt,
      contextQueries: queries,
      memorySlugs: slugs,
    };
  }

  async #validateQueries(queries: readonly ContextQuery[]): Promise<void> {
    for (const [queryIndex, query] of queries.entries()) {
      try {
        await this.queryValidator.validate(query.sparql);
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        throw new WorkshopError(
          normalized.code,
          `Context query ${queryIndex}${query.label ? ` (${query.label})` : ''}: ${normalized.message}`,
          normalized.status,
          {
            ...normalized.details,
            queryIndex,
            ...(query.label ? { label: query.label } : {}),
          },
        );
      }
    }
  }

  #mutation<T>(
    operation: WorkshopOperation,
    principalId: string | undefined,
    taskId: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    return observed(
      this.options.observe,
      {
        operation,
        taskId,
        ...(principalId ? { principalId } : {}),
      },
      execute,
    );
  }

  async #context(
    authorization: AuthorizationContext,
    capability: 'read' | 'task-write' | 'admin' = 'read',
  ): Promise<AuthorizationContext> {
    const context = await requireCurrentAuthorization(
      this.options.authorization,
      authorization,
    );
    requireCapability(context, capability);
    return context;
  }

  async #recheck(
    hydrated: TaskRow,
    context: AuthorizationContext,
  ): Promise<void> {
    await requireCurrentAuthorization(this.options.authorization, context);
    const predicate = visibilitySql('workshop_tasks', context);
    const row = await this.db
      .prepare(
        `SELECT revision, installation_id, authorization_revision, visibility_scope
         FROM workshop_tasks WHERE id = ? AND ${predicate.sql}`,
      )
      .bind(hydrated.id, ...predicate.values)
      .first<
        Pick<
          TaskRow,
          | 'revision'
          | 'installation_id'
          | 'authorization_revision'
          | 'visibility_scope'
        >
      >();
    if (
      !row ||
      row.revision !== hydrated.revision ||
      row.authorization_revision !== hydrated.authorization_revision ||
      row.visibility_scope !== hydrated.visibility_scope
    )
      throw denied();
    authorizeRecord(toAuthorizationRecord(row), context);
  }

  async #recheckAll(
    hydrated: readonly TaskRow[],
    context: AuthorizationContext,
  ): Promise<void> {
    await requireCurrentAuthorization(this.options.authorization, context);
    if (hydrated.length === 0) return;
    const predicate = visibilitySql('workshop_tasks', context);
    type AuthorizationRow = Pick<
      TaskRow,
      | 'id'
      | 'revision'
      | 'installation_id'
      | 'authorization_revision'
      | 'visibility_scope'
    >;
    const current = new Map<string, AuthorizationRow>();
    for (
      let offset = 0;
      offset < hydrated.length;
      offset += AUTHORIZED_ID_BATCH
    ) {
      const batch = hydrated.slice(offset, offset + AUTHORIZED_ID_BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const result = await this.db
        .prepare(
          `SELECT id, revision, installation_id, authorization_revision, visibility_scope
           FROM workshop_tasks
           WHERE id IN (${placeholders}) AND ${predicate.sql}`,
        )
        .bind(...batch.map(({ id }) => id), ...predicate.values)
        .all<AuthorizationRow>();
      for (const row of result.results) current.set(row.id, row);
    }
    for (const candidate of hydrated) {
      const row = current.get(candidate.id);
      if (
        !row ||
        row.revision !== candidate.revision ||
        row.authorization_revision !== candidate.authorization_revision ||
        row.visibility_scope !== candidate.visibility_scope
      )
        throw denied();
      authorizeRecord(toAuthorizationRecord(row), context);
    }
  }

  #getRow(id: string, context: AuthorizationContext): Promise<TaskRow | null> {
    if (typeof id !== 'string' || !id.trim())
      throw validation('Task id is required');
    const predicate = visibilitySql('workshop_tasks', context);
    return this.db
      .prepare(`SELECT * FROM workshop_tasks WHERE id = ? AND ${predicate.sql}`)
      .bind(id, ...predicate.values)
      .first<TaskRow>();
  }

  async #getForMutation(
    id: string,
    context: AuthorizationContext,
  ): Promise<Task> {
    const row = await this.#getRow(id, context);
    if (!row) throw denied();
    await this.#recheck(row, context);
    return toTask(row);
  }

  async #retryCompletion(
    id: string,
    resultValue: unknown,
    context: AuthorizationContext,
    previousRevision: number,
    enabled: boolean,
  ): Promise<Task | null> {
    if (!enabled) return null;
    const latestRow = await this.#getRow(id, context);
    if (!latestRow) return null;
    const latest = toTask(latestRow);
    if (
      !latest.claimed ||
      latest.completedAt ||
      latest.archivedAt ||
      latest.revision <= previousRevision
    )
      return null;
    return this.complete(id, resultValue, context, false);
  }
}

function idempotentTask(
  row: TaskRow,
  input: {
    description: string;
    title: string;
    objective?: string;
    constraints: string[];
    acceptanceCriteria: string[];
    relationships: TaskRelationship[];
    assignedPrincipalId?: string;
    language: string;
    attribution: Record<string, unknown>;
    role?: string;
    prompt: string;
    contextQueries: ContextQuery[];
    memorySlugs: string[];
    visibility: VisibilityScopeV1;
  },
): Task {
  const task = toTask(row);
  if (
    task.description !== input.description ||
    task.title !== input.title ||
    task.objective !== input.objective ||
    task.role !== input.role ||
    task.prompt !== input.prompt ||
    JSON.stringify(task.contextQueries) !==
      JSON.stringify(input.contextQueries) ||
    JSON.stringify(task.memorySlugs) !== JSON.stringify(input.memorySlugs) ||
    serializeVisibilityScope(task.visibility) !==
      serializeVisibilityScope(input.visibility)
  ) {
    throw new WorkshopError(
      'conflict',
      'Idempotent task input conflicts with existing content',
    );
  }
  return task;
}

function toTask(row: TaskRow): Task {
  const authorization = toAuthorizationRecord(row);
  if (!row.owner_principal_id || !row.workspace_id) throw denied();
  const parsedQueries = JSON.parse(row.context_queries) as ContextQuery[];
  const parsedSlugs = JSON.parse(row.memory_slugs) as string[];
  return {
    id: row.id,
    title: row.title ?? row.description,
    ...(row.objective ? { objective: row.objective } : {}),
    description: row.description,
    constraints: JSON.parse(row.constraints_json) as string[],
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    relationships: JSON.parse(row.relationships_json) as TaskRelationship[],
    ...(row.assigned_principal_id
      ? { assignedPrincipalId: row.assigned_principal_id }
      : {}),
    language: row.language,
    attribution: JSON.parse(row.attribution_json) as Record<string, unknown>,
    ...(row.role ? { role: row.role } : {}),
    prompt: row.prompt,
    contextQueries: parsedQueries,
    memorySlugs: parsedSlugs,
    claimed: row.claimed === 1,
    ...(row.claimed_at ? { claimedAt: normalizeDate(row.claimed_at) } : {}),
    ...(row.completed_at
      ? { completedAt: normalizeDate(row.completed_at) }
      : {}),
    ...(row.archived_at ? { archivedAt: normalizeDate(row.archived_at) } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.outcome_kind
      ? { outcomeKind: row.outcome_kind as TaskOutcomeKind }
      : {}),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    revision: row.revision,
    policyRevision: row.policy_revision,
    installationId: authorization.installationId,
    ownerPrincipalId: row.owner_principal_id,
    workspaceId: row.workspace_id,
    visibility: authorization.visibility,
    authorizationRevision: authorization.authorizationRevision,
  };
}

function parseTaskRevision(
  snapshot: string,
  taskId: string,
  revision: number,
): Task {
  let value: unknown;
  try {
    value = JSON.parse(snapshot);
  } catch {
    throw denied();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw denied();
  const task = value as Task;
  if (
    task.id !== taskId ||
    task.revision !== revision ||
    typeof task.installationId !== 'string' ||
    !Number.isSafeInteger(task.authorizationRevision) ||
    !task.visibility
  )
    throw denied();
  return task;
}

function toAuthorizationRecord(
  row: Pick<
    TaskRow,
    'installation_id' | 'authorization_revision' | 'visibility_scope'
  >,
) {
  if (
    !row.installation_id ||
    row.authorization_revision === null ||
    !row.visibility_scope
  )
    throw denied();
  let visibility: unknown;
  try {
    visibility = JSON.parse(row.visibility_scope);
  } catch {
    throw denied();
  }
  const normalized = normalizeVisibilityScope(visibility as never);
  if (serializeVisibilityScope(normalized) !== row.visibility_scope)
    throw denied();
  return {
    installationId: row.installation_id,
    authorizationRevision: row.authorization_revision,
    visibility: normalized,
  };
}

interface ResolvedRevisionPrecondition {
  column: 'revision' | 'updated_at';
  value: number | string;
}

function revisionPrecondition(input: {
  expectedRevision?: number | undefined;
  expectedUpdatedAt?: string | undefined;
}): ResolvedRevisionPrecondition {
  const expectedUpdatedAt =
    input.expectedUpdatedAt === undefined
      ? undefined
      : isoDate(input.expectedUpdatedAt, 'expectedUpdatedAt');
  if (input.expectedRevision !== undefined) {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw validation('expectedRevision must be a positive safe integer');
    }
    return { column: 'revision', value: input.expectedRevision };
  }
  if (expectedUpdatedAt !== undefined) {
    return { column: 'updated_at', value: expectedUpdatedAt };
  }
  throw validation('expectedRevision or expectedUpdatedAt is required');
}

function normalizeDate(value: string): string {
  const parsed = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(parsed).toISOString();
}

function nextTimestamp(candidate: string, current: string): string {
  return new Date(
    Math.max(new Date(candidate).getTime(), new Date(current).getTime() + 1),
  ).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function isUniqueError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)
  );
}

function stringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxBytes: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw validation(`${field} must contain at most ${maxItems} entries`);
  const result = value.map((entry, index) =>
    requiredText(entry, `${field}[${index}]`, maxBytes),
  );
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes)
    throw validation(`${field} exceeds its byte limit`);
  return result;
}

function relationshipList(value: unknown): TaskRelationship[] {
  if (!Array.isArray(value) || value.length > 200)
    throw validation('relationships must contain at most 200 entries');
  const kinds = new Set([
    'duplicate',
    'overlaps',
    'reuses',
    'mergeable',
    'splittable',
    'blocks',
    'related',
  ]);
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw validation(`relationships[${index}] must be an object`);
    const candidate = entry as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(',') !== 'kind,taskId' ||
      typeof candidate.kind !== 'string' ||
      !kinds.has(candidate.kind)
    )
      throw validation(`relationships[${index}] is invalid`);
    return {
      kind: candidate.kind as TaskRelationship['kind'],
      taskId: requiredText(
        candidate.taskId,
        `relationships[${index}].taskId`,
        256,
      ),
    };
  });
}

function jsonObject(
  value: unknown,
  field: string,
  maxBytes: number,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw validation(`${field} must be an object`);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw validation(`${field} exceeds its byte limit`);
  return value as Record<string, unknown>;
}

function normalizeOutcome(value: unknown): TaskOutcomeInput {
  if (typeof value === 'string') return { kind: 'success', result: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw validation('result must be text or a Task outcome');
  const candidate = value as Record<string, unknown>;
  if (
    !['success', 'negative', 'inconclusive'].includes(String(candidate.kind)) ||
    typeof candidate.result !== 'string'
  )
    throw validation('Task outcome is invalid');
  return {
    kind: candidate.kind as TaskOutcomeKind,
    result: candidate.result,
  };
}
