import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type {
  ContextQuery,
  CreateTaskInput,
  Task,
  TaskFilters,
  TaskPage,
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
  idempotency_key: string | null;
  description: string;
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
  installation_id: string | null;
  owner_principal_id: string | null;
  workspace_id: string | null;
  visibility_scope: string | null;
  authorization_revision: number | null;
}

const NEXT_UPDATED_AT =
  "CASE WHEN ? > updated_at THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END";
const AUTHORIZED_ID_BATCH = 80;

export interface TaskServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  createId?: () => string;
  observe?: ObserveWorkshop;
  authorization: WorkshopAuthorizationAuthority;
  cursorCodec: WorkshopCursorCodec;
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
        const mutation = this.db
          .prepare(
            `INSERT INTO workshop_tasks
             (id, idempotency_key, description, role, prompt, context_queries, memory_slugs, claimed,
              created_at, updated_at, installation_id, owner_principal_id, workspace_id,
              visibility_scope, authorization_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .bind(
            id,
            storedIdempotencyKey ?? null,
            normalized.description,
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
          );
        const row =
          await this.options.authorization.commitTaskMutation<TaskRow>(
            this.db,
            context,
            mutation,
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
    const current = await this.get(id, context);
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
      const mutation = this.db
        .prepare(
          `UPDATE workshop_tasks
           SET description = ?, role = ?, prompt = ?, context_queries = ?, memory_slugs = ?,
               visibility_scope = ?, authorization_revision = ?,
               revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql}
           RETURNING *`,
        )
        .bind(
          description,
          role ?? null,
          prompt,
          JSON.stringify(queries),
          JSON.stringify(slugs),
          serializeVisibilityScope(scope),
          context.authorizationRevision,
          now,
          now,
          id,
          expected.value,
          ...predicate.values,
        );
      const row = await this.options.authorization.commitTaskMutation<TaskRow>(
        this.db,
        context,
        mutation,
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
    const predicate = visibilitySql('workshop_tasks', context);
    const expected = revisionPrecondition(options);
    const now = this.#clock().toISOString();
    return this.#mutation('task.archive', context.principalId, id, async () => {
      const mutation = this.db
        .prepare(
          `UPDATE workshop_tasks SET archived_at = ?, claimed = 0, claimed_at = NULL,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
             AND (claimed = 0 OR ? = 1) AND ${predicate.sql} RETURNING *`,
        )
        .bind(
          now,
          now,
          now,
          id,
          expected.value,
          context.capabilities.includes('admin') ? 1 : 0,
          ...predicate.values,
        );
      const row = await this.options.authorization.commitTaskMutation<TaskRow>(
        this.db,
        context,
        mutation,
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
    const predicate = visibilitySql('workshop_tasks', context);
    const now = this.#clock().toISOString();
    return this.#mutation('task.claim', context.principalId, id, async () => {
      const mutation = this.db
        .prepare(
          `UPDATE workshop_tasks SET claimed = 1, claimed_at = ?,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 0 AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
        )
        .bind(now, now, now, id, ...predicate.values);
      const row = await this.options.authorization.commitTaskMutation<TaskRow>(
        this.db,
        context,
        mutation,
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
  ): Promise<Task> {
    const context = await this.#context(authorization, 'task-write');
    const predicate = visibilitySql('workshop_tasks', context);
    const result = requiredText(
      resultValue,
      'result',
      this.#limits.maxResultBytes,
    );
    const now = this.#clock().toISOString();
    return this.#mutation(
      'task.complete',
      context.principalId,
      id,
      async () => {
        const mutation = this.db
          .prepare(
            `UPDATE workshop_tasks
           SET claimed = 0, claimed_at = NULL, completed_at = ?, result = ?,
               revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 1 AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
          )
          .bind(now, result, now, now, id, ...predicate.values);
        const row =
          await this.options.authorization.commitTaskMutation<TaskRow>(
            this.db,
            context,
            mutation,
          );
        if (!row) {
          if (!(await this.#getRow(id, await this.#context(context))))
            throw denied();
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
    const predicate = visibilitySql('workshop_tasks', context);
    const cutoff = isoDate(claimedBefore, 'claimedBefore');
    const now = this.#clock().toISOString();
    return this.#mutation(
      'task.reset-claim',
      context.principalId,
      id,
      async () => {
        const mutation = this.db
          .prepare(
            `UPDATE workshop_tasks SET claimed = 0, claimed_at = NULL,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 1 AND claimed_at < ? AND completed_at IS NULL AND archived_at IS NULL
             AND ${predicate.sql} RETURNING *`,
          )
          .bind(now, now, id, cutoff, ...predicate.values);
        const row =
          await this.options.authorization.commitTaskMutation<TaskRow>(
            this.db,
            context,
            mutation,
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

  async #validateInput(
    input: CreateTaskInput,
    authorization?: AuthorizationContext,
  ): Promise<{
    description: string;
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
}

function idempotentTask(
  row: TaskRow,
  input: {
    description: string;
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
    description: row.description,
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
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    revision: row.revision,
    installationId: authorization.installationId,
    ownerPrincipalId: row.owner_principal_id,
    workspaceId: row.workspace_id,
    visibility: authorization.visibility,
    authorizationRevision: authorization.authorizationRevision,
  };
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function isUniqueError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/iu.test(error.message)
  );
}
