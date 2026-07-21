import { WorkshopError, normalizeWorkshopError } from '../protocol/errors.js';
import type {
  ContextQuery,
  CreateTaskInput,
  Task,
  TaskFilters,
  TaskPage,
  UpdateTaskInput,
} from '../protocol/tasks.js';
import { taskState } from '../protocol/tasks.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { D1DatabaseLike } from './database.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { MemoryService } from './memories.js';
import type { ObserveWorkshop, WorkshopOperation } from './observability.js';
import { observed } from './observability.js';
import type { SparqlService } from './sparql.js';
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
}

const NEXT_UPDATED_AT =
  "CASE WHEN ? > updated_at THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END";

export interface TaskServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  createId?: () => string;
  observe?: ObserveWorkshop;
}

export class TaskService {
  readonly #limits: WorkshopLimits;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    readonly db: D1DatabaseLike,
    readonly memories: MemoryService,
    readonly sparql: SparqlService,
    private readonly options: TaskServiceOptions = {},
  ) {
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async get(id: string): Promise<Task> {
    const row = await this.#getRow(id);
    if (!row) throw new WorkshopError('not_found', `Task ${id} was not found`);
    return toTask(row);
  }

  async list(filters: TaskFilters = {}): Promise<TaskPage> {
    const limit = pageLimit(filters.limit, this.#limits);
    const cursor = decodeCursor(filters.cursor);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.role) {
      clauses.push('role = ?');
      values.push(filters.role);
    }
    if (filters.claimed !== undefined) {
      clauses.push('claimed = ?');
      values.push(filters.claimed ? 1 : 0);
    }
    if (filters.updatedAfter) {
      clauses.push('updated_at >= ?');
      values.push(isoDate(filters.updatedAfter, 'updatedAfter'));
    }
    if (filters.text?.trim()) {
      clauses.push(
        "(description LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeLike(filters.text.trim())}%`;
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
    if (cursor) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND id > ?))');
      values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const sql = `SELECT * FROM workshop_tasks${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, id ASC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...values, limit + 1)
      .all<TaskRow>();
    const rows = result.results ?? [];
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toTask),
      cursor:
        rows.length > limit && last
          ? encodeCursor({
              updatedAt: normalizeDate(last.updated_at),
              id: last.id,
            })
          : null,
    };
  }

  search(filters: TaskFilters = {}): Promise<TaskPage> {
    return this.list(filters);
  }

  async create(input: CreateTaskInput, principalId?: string): Promise<Task> {
    const idempotencyKey = optionalText(
      input.idempotencyKey,
      'idempotencyKey',
      256,
    );
    const normalized = await this.#validateInput(input);
    if (idempotencyKey) {
      const existing = await this.db
        .prepare('SELECT * FROM workshop_tasks WHERE idempotency_key = ?')
        .bind(idempotencyKey)
        .first<TaskRow>();
      if (existing) return idempotentTask(existing, normalized);
    }
    const id = this.#createId();
    const now = this.#clock().toISOString();
    return this.#mutation('task.create', principalId, id, async () => {
      try {
        const row = await this.db
          .prepare(
            `INSERT INTO workshop_tasks
             (id, idempotency_key, description, role, prompt, context_queries, memory_slugs, claimed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING *`,
          )
          .bind(
            id,
            idempotencyKey ?? null,
            normalized.description,
            normalized.role ?? null,
            normalized.prompt,
            JSON.stringify(normalized.contextQueries),
            JSON.stringify(normalized.memorySlugs),
            now,
            now,
          )
          .first<TaskRow>();
        if (!row)
          throw new WorkshopError('internal_error', 'Task creation failed');
        return toTask(row);
      } catch (error) {
        if (idempotencyKey && isUniqueError(error)) {
          const existing = await this.db
            .prepare('SELECT * FROM workshop_tasks WHERE idempotency_key = ?')
            .bind(idempotencyKey)
            .first<TaskRow>();
          if (existing) return idempotentTask(existing, normalized);
        }
        throw error;
      }
    });
  }

  async update(
    id: string,
    input: UpdateTaskInput,
    principalId?: string,
  ): Promise<Task> {
    const current = await this.get(id);
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
        : memorySlugs(input.memorySlugs);
    if (input.contextQueries !== undefined)
      await this.#validateQueries(queries);
    if (input.memorySlugs !== undefined) await this.memories.requireAll(slugs);
    const now = this.#clock().toISOString();
    return this.#mutation('task.update', principalId, id, async () => {
      const row = await this.db
        .prepare(
          `UPDATE workshop_tasks
           SET description = ?, role = ?, prompt = ?, context_queries = ?, memory_slugs = ?,
               revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
           RETURNING *`,
        )
        .bind(
          description,
          role ?? null,
          prompt,
          JSON.stringify(queries),
          JSON.stringify(slugs),
          now,
          now,
          id,
          expected.value,
        )
        .first<TaskRow>();
      if (!row) {
        throw new WorkshopError(
          'conflict',
          `Task ${id} changed state or was updated since it was read`,
        );
      }
      return toTask(row);
    });
  }

  async archive(
    id: string,
    options: {
      expectedRevision?: number;
      expectedUpdatedAt?: string;
      administrative?: boolean;
      principalId?: string;
    },
  ): Promise<Task> {
    const expected = revisionPrecondition(options);
    const now = this.#clock().toISOString();
    return this.#mutation('task.archive', options.principalId, id, async () => {
      const row = await this.db
        .prepare(
          `UPDATE workshop_tasks SET archived_at = ?, claimed = 0, claimed_at = NULL,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND ${expected.column} = ? AND completed_at IS NULL AND archived_at IS NULL
             AND (claimed = 0 OR ? = 1) RETURNING *`,
        )
        .bind(now, now, now, id, expected.value, options.administrative ? 1 : 0)
        .first<TaskRow>();
      if (!row) {
        const current = await this.#getRow(id);
        if (!current)
          throw new WorkshopError('not_found', `Task ${id} was not found`);
        throw new WorkshopError(
          'conflict',
          current.archived_at
            ? `Task ${id} is already archived`
            : current.completed_at
              ? `Task ${id} is already completed`
              : !matchesRevisionPrecondition(current, expected)
                ? `Task ${id} changed state or was updated since it was read`
                : 'A claimed task requires administrative authorization to archive',
        );
      }
      return toTask(row);
    });
  }

  async claim(id: string, principalId?: string): Promise<Task> {
    const now = this.#clock().toISOString();
    return this.#mutation('task.claim', principalId, id, async () => {
      const row = await this.db
        .prepare(
          `UPDATE workshop_tasks SET claimed = 1, claimed_at = ?,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 0 AND completed_at IS NULL AND archived_at IS NULL RETURNING *`,
        )
        .bind(now, now, now, id)
        .first<TaskRow>();
      if (!row) {
        const current = await this.#getRow(id);
        if (!current)
          throw new WorkshopError('not_found', `Task ${id} was not found`);
        throw new WorkshopError(
          'conflict',
          `Task ${id} cannot be claimed while ${taskState(toTask(current))}`,
        );
      }
      return toTask(row);
    });
  }

  async complete(
    id: string,
    resultValue: unknown,
    principalId?: string,
  ): Promise<Task> {
    const result = requiredText(
      resultValue,
      'result',
      this.#limits.maxResultBytes,
    );
    const now = this.#clock().toISOString();
    return this.#mutation('task.complete', principalId, id, async () => {
      const row = await this.db
        .prepare(
          `UPDATE workshop_tasks
           SET claimed = 0, claimed_at = NULL, completed_at = ?, result = ?,
               revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 1 AND completed_at IS NULL AND archived_at IS NULL RETURNING *`,
        )
        .bind(now, result, now, now, id)
        .first<TaskRow>();
      if (!row) {
        const current = await this.#getRow(id);
        if (!current)
          throw new WorkshopError('not_found', `Task ${id} was not found`);
        throw new WorkshopError(
          'conflict',
          `Task ${id} is not claimable for completion`,
        );
      }
      return toTask(row);
    });
  }

  async resetAbandonedClaim(
    id: string,
    claimedBefore: string,
    principalId: string,
  ): Promise<Task> {
    const cutoff = isoDate(claimedBefore, 'claimedBefore');
    const now = this.#clock().toISOString();
    return this.#mutation('task.reset-claim', principalId, id, async () => {
      const row = await this.db
        .prepare(
          `UPDATE workshop_tasks SET claimed = 0, claimed_at = NULL,
             revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ? AND claimed = 1 AND claimed_at < ? AND completed_at IS NULL AND archived_at IS NULL RETURNING *`,
        )
        .bind(now, now, id, cutoff)
        .first<TaskRow>();
      if (!row) {
        throw new WorkshopError(
          'conflict',
          `Task ${id} has no abandoned claim before the supplied cutoff`,
        );
      }
      return toTask(row);
    });
  }

  async #validateInput(input: CreateTaskInput): Promise<{
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
    const slugs = memorySlugs(input.memorySlugs);
    await this.#validateQueries(queries);
    await this.memories.requireAll(slugs);
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
        await this.sparql.validate(query.sparql);
        await this.sparql.dryRun(query.sparql);
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

  #getRow(id: string): Promise<TaskRow | null> {
    if (typeof id !== 'string' || !id.trim())
      throw validation('Task id is required');
    return this.db
      .prepare('SELECT * FROM workshop_tasks WHERE id = ?')
      .bind(id)
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
  },
): Task {
  const task = toTask(row);
  if (
    task.description !== input.description ||
    task.role !== input.role ||
    task.prompt !== input.prompt ||
    JSON.stringify(task.contextQueries) !==
      JSON.stringify(input.contextQueries) ||
    JSON.stringify(task.memorySlugs) !== JSON.stringify(input.memorySlugs)
  ) {
    throw new WorkshopError(
      'conflict',
      `Idempotency key ${row.idempotency_key ?? ''} was already used with different task content`,
    );
  }
  return task;
}

function toTask(row: TaskRow): Task {
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

function matchesRevisionPrecondition(
  row: TaskRow,
  expected: ResolvedRevisionPrecondition,
): boolean {
  return expected.column === 'revision'
    ? row.revision === expected.value
    : row.updated_at === expected.value;
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
