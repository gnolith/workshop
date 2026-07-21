import { WorkshopError } from '../protocol/errors.js';
import type {
  Memory,
  MemoryFilters,
  MemoryPage,
  UpsertMemoryInput,
} from '../protocol/memories.js';
import type { D1DatabaseLike } from './database.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';
import { memorySlug, pageLimit, requiredText } from './validation.js';

interface MemoryRow {
  slug: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  observe?: ObserveWorkshop;
}

export class MemoryService {
  readonly #limits: WorkshopLimits;
  readonly #clock: () => Date;

  constructor(
    readonly db: D1DatabaseLike,
    private readonly options: MemoryServiceOptions = {},
  ) {
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(slugValue: string): Promise<Memory> {
    const slug = memorySlug(slugValue);
    const row = await this.db
      .prepare('SELECT * FROM workshop_memories WHERE slug = ?')
      .bind(slug)
      .first<MemoryRow>();
    if (!row)
      throw new WorkshopError('not_found', `Memory ${slug} was not found`);
    return toMemory(row);
  }

  async exists(slugValue: string): Promise<boolean> {
    const slug = memorySlug(slugValue);
    return Boolean(
      await this.db
        .prepare('SELECT slug FROM workshop_memories WHERE slug = ?')
        .bind(slug)
        .first(),
    );
  }

  async requireAll(slugs: readonly string[]): Promise<void> {
    for (const [index, slug] of slugs.entries()) {
      if (!(await this.exists(slug))) {
        throw new WorkshopError(
          'validation_failed',
          `Memory ${slug} does not exist`,
          400,
          { field: 'memorySlugs', memoryIndex: index, slug },
        );
      }
    }
  }

  async list(filters: MemoryFilters = {}): Promise<MemoryPage> {
    const limit = pageLimit(filters.limit, this.#limits);
    const cursor = decodeCursor(filters.cursor);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.text?.trim()) {
      clauses.push(
        "(description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeLike(filters.text.trim())}%`;
      values.push(pattern, pattern);
    }
    if (cursor) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND slug > ?))');
      values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const sql = `SELECT * FROM workshop_memories${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, slug ASC LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...values, limit + 1)
      .all<MemoryRow>();
    const rows = result.results ?? [];
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toMemory),
      cursor:
        rows.length > limit && last
          ? encodeCursor({ updatedAt: last.updated_at, id: last.slug })
          : null,
    };
  }

  async upsert(
    slugValue: string,
    input: UpsertMemoryInput,
    principalId?: string,
  ): Promise<Memory> {
    const slug = memorySlug(slugValue);
    const description = requiredText(
      input.description,
      'description',
      this.#limits.maxDescriptionBytes,
    );
    const content = requiredText(
      input.content,
      'content',
      this.#limits.maxMemoryBytes,
    );
    const now = this.#clock().toISOString();
    return observed(
      this.options.observe,
      { operation: 'memory.upsert', ...(principalId ? { principalId } : {}) },
      async () => {
        let row: MemoryRow | null;
        if (input.expectedUpdatedAt) {
          row = await this.db
            .prepare(
              'UPDATE workshop_memories SET description = ?, content = ?, updated_at = ? WHERE slug = ? AND updated_at = ? RETURNING *',
            )
            .bind(description, content, now, slug, input.expectedUpdatedAt)
            .first<MemoryRow>();
          if (!row) {
            throw new WorkshopError(
              'conflict',
              `Memory ${slug} changed since it was read`,
            );
          }
        } else {
          row = await this.db
            .prepare(
              `INSERT INTO workshop_memories (slug, description, content, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(slug) DO UPDATE SET description = excluded.description, content = excluded.content, updated_at = excluded.updated_at
               RETURNING *`,
            )
            .bind(slug, description, content, now, now)
            .first<MemoryRow>();
        }
        if (!row)
          throw new WorkshopError('internal_error', 'Memory write failed');
        return toMemory(row);
      },
    );
  }
}

function toMemory(row: MemoryRow): Memory {
  return {
    slug: row.slug,
    description: row.description,
    content: row.content,
    createdAt: normalizeSqlDate(row.created_at),
    updatedAt: normalizeSqlDate(row.updated_at),
  };
}

function normalizeSqlDate(value: string): string {
  const parsed = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(parsed).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}
