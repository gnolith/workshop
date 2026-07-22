import { WorkshopError } from '../protocol/errors.js';
import type {
  Memory,
  MemoryFilters,
  MemoryPage,
  UpsertMemoryInput,
} from '../protocol/memories.js';
import type { D1DatabaseLike } from './database.js';
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
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';
import {
  authorizeRecord,
  defaultVisibility,
  denied,
  normalizeVisibilityScope,
  requireActiveWorkspace,
  requireCapability,
  requireCurrentAuthorization,
  serializeVisibilityScope,
  visibilitySql,
  type AuthorizationContext,
  type WorkshopAuthorizationAuthority,
} from './authorization.js';
import {
  isoDate,
  memorySlug,
  memorySlugs,
  pageLimit,
  requiredText,
  validation,
} from './validation.js';

interface MemoryRow {
  slug: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
  revision: number;
  idempotency_key: string | null;
  installation_id: string | null;
  owner_principal_id: string | null;
  workspace_id: string | null;
  visibility_scope: string | null;
  authorization_revision: number | null;
}

const NEXT_UPDATED_AT =
  "CASE WHEN ? > updated_at THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END";
const AUTHORIZED_ID_BATCH = 80;

export interface MemoryServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  observe?: ObserveWorkshop;
  authorization: WorkshopAuthorizationAuthority;
  cursorCodec: WorkshopCursorCodec;
}

export class MemoryService {
  readonly #limits: WorkshopLimits;
  readonly #clock: () => Date;

  constructor(
    readonly db: D1DatabaseLike,
    private readonly options: MemoryServiceOptions,
  ) {
    if (!options.authorization || !options.cursorCodec) throw denied();
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(
    slugValue: string,
    authorization: AuthorizationContext,
  ): Promise<Memory> {
    const context = await this.#context(authorization);
    const slug = memorySlug(slugValue);
    const predicate = visibilitySql('workshop_memories', context);
    const row = await this.db
      .prepare(
        `SELECT * FROM workshop_memories WHERE slug = ? AND ${predicate.sql}`,
      )
      .bind(slug, ...predicate.values)
      .first<MemoryRow>();
    if (!row) throw denied();
    const memory = toMemory(row);
    await this.#recheck(row, context);
    return memory;
  }

  async exists(
    slugValue: string,
    authorization: AuthorizationContext,
  ): Promise<boolean> {
    const context = await this.#context(authorization);
    const slug = memorySlug(slugValue);
    const predicate = visibilitySql('workshop_memories', context);
    const row = await this.db
      .prepare(
        `SELECT slug, revision, installation_id, authorization_revision, visibility_scope
         FROM workshop_memories WHERE slug = ? AND ${predicate.sql}`,
      )
      .bind(slug, ...predicate.values)
      .first<MemoryAuthorizationRow>();
    if (!row) return false;
    await this.#recheckAll([row], context);
    return true;
  }

  async requireAll(
    slugs: readonly string[],
    authorization: AuthorizationContext,
  ): Promise<void> {
    const context = await this.#context(authorization);
    const requested = memorySlugs(slugs, this.#limits);
    if (requested.length === 0) return;
    const predicate = visibilitySql('workshop_memories', context);
    const placeholders = requested.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT slug, revision, installation_id, authorization_revision, visibility_scope
         FROM workshop_memories
         WHERE slug IN (${placeholders}) AND ${predicate.sql}`,
      )
      .bind(...requested, ...predicate.values)
      .all<MemoryAuthorizationRow>();
    const rows = result.results ?? [];
    if (rows.length !== requested.length) throw denied();
    await this.#recheckAll(rows, context);
  }

  async list(
    filters: MemoryFilters = {},
    authorization: AuthorizationContext,
  ): Promise<MemoryPage> {
    const context = await this.#context(authorization);
    const limit = pageLimit(filters.limit, this.#limits);
    const textFilter = filters.text?.trim() || null;
    const binding: CursorBinding = {
      operation: 'memory.list',
      domain: 'memory',
      query: 'updated_at_desc__slug_asc.v1',
      filters: { text: textFilter, limit },
    };
    const predicate = visibilitySql('workshop_memories', context);
    const clauses: string[] = [predicate.sql];
    const values: unknown[] = [...predicate.values];
    if (textFilter) {
      clauses.push(
        "(description LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeLike(textFilter)}%`;
      values.push(pattern, pattern);
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
          `SELECT slug, revision, updated_at FROM workshop_memories
           WHERE ${clauses.join(' AND ')}
           ORDER BY updated_at DESC, slug ASC LIMIT 1001`,
        )
        .bind(...values)
        .all<{ slug: string; revision: number; updated_at: string }>();
      assertCursorCandidatesBounded(candidates.results.length);
      if (candidates.results.length === 0) return { items: [], cursor: null };
      snapshot = await createCursorSnapshot(
        this.db,
        this.options.authorization,
        this.options.cursorCodec,
        binding,
        context,
        candidates.results.map((row) => ({
          id: row.slug,
          revision: row.revision,
          updatedAt: row.updated_at,
        })),
        limit,
        this.#clock(),
      );
    }
    const entries = await readCursorEntries(this.db, snapshot, limit);
    const hydrated: MemoryRow[] = [];
    for (
      let offset = 0;
      offset < entries.length;
      offset += AUTHORIZED_ID_BATCH
    ) {
      const batch = entries.slice(offset, offset + AUTHORIZED_ID_BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const result = await this.db
        .prepare(
          `SELECT * FROM workshop_memories
           WHERE slug IN (${placeholders}) AND ${predicate.sql}`,
        )
        .bind(...batch.map(({ id }) => id), ...predicate.values)
        .all<MemoryRow>();
      hydrated.push(...result.results);
    }
    const byId = new Map(hydrated.map((row) => [row.slug, row]));
    const rows = entries.map((entry) => {
      const row = byId.get(entry.id);
      if (
        !row ||
        row.revision !== entry.revision ||
        row.updated_at !== entry.updatedAt
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
      items: visible.map(toMemory),
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

  async upsert(
    slugValue: string,
    input: UpsertMemoryInput,
    authorization: AuthorizationContext,
  ): Promise<Memory> {
    const context = await this.#context(authorization, 'memory-write');
    const workspaceId = requireActiveWorkspace(context);
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
    const expected = revisionPrecondition(input);
    const current =
      expected || input.visibility
        ? await this.#policyRow(slug, context)
        : undefined;
    if (expected && !current) throw denied();
    if (
      input.visibility &&
      current &&
      current.owner_principal_id !== context.principalId &&
      !context.capabilities.includes('admin')
    )
      throw denied();
    const requestedScope = input.visibility
      ? normalizeVisibilityScope(input.visibility)
      : undefined;
    const predicate = visibilitySql('workshop_memories', context);
    const now = this.#clock().toISOString();
    return observed(
      this.options.observe,
      { operation: 'memory.upsert', principalId: context.principalId },
      async () => {
        let row: MemoryRow | null;
        if (expected) {
          const mutation = this.db
            .prepare(
              `UPDATE workshop_memories SET description = ?, content = ?,
                 visibility_scope = COALESCE(?, visibility_scope), authorization_revision = ?,
                 revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
               WHERE slug = ? AND ${expected.column} = ? AND ${predicate.sql} RETURNING *`,
            )
            .bind(
              description,
              content,
              requestedScope ? serializeVisibilityScope(requestedScope) : null,
              context.authorizationRevision,
              now,
              now,
              slug,
              expected.value,
              ...predicate.values,
            );
          row =
            await this.options.authorization.commitMemoryMutation<MemoryRow>(
              this.db,
              context,
              mutation,
            );
          if (!row) {
            await this.get(slug, await this.#context(context));
            throw new WorkshopError('conflict', 'Memory state changed');
          }
        } else {
          const update = this.db
            .prepare(
              `UPDATE workshop_memories SET description = ?, content = ?,
                 visibility_scope = COALESCE(?, visibility_scope), authorization_revision = ?,
                 revision = revision + 1, updated_at = ${NEXT_UPDATED_AT}
               WHERE slug = ? AND ${predicate.sql} RETURNING *`,
            )
            .bind(
              description,
              content,
              requestedScope ? serializeVisibilityScope(requestedScope) : null,
              context.authorizationRevision,
              now,
              now,
              slug,
              ...predicate.values,
            );
          row =
            await this.options.authorization.commitMemoryMutation<MemoryRow>(
              this.db,
              context,
              update,
            );
          if (!row) {
            const insert = this.db
              .prepare(
                `INSERT INTO workshop_memories
               (slug, description, content, created_at, updated_at, installation_id,
                owner_principal_id, workspace_id, visibility_scope, authorization_revision)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(installation_id, slug) DO NOTHING RETURNING *`,
              )
              .bind(
                slug,
                description,
                content,
                now,
                now,
                context.installationId,
                context.principalId,
                workspaceId,
                serializeVisibilityScope(
                  requestedScope ?? defaultVisibility(context),
                ),
                context.authorizationRevision,
              );
            row =
              await this.options.authorization.commitMemoryMutation<MemoryRow>(
                this.db,
                context,
                insert,
              );
            if (!row) throw denied();
          }
        }
        if (!row)
          throw new WorkshopError('internal_error', 'Memory write failed');
        authorizeRecord(toAuthorizationRecord(row), context);
        return toMemory(row);
      },
    );
  }

  /**
   * Create onboarding memory exactly once. Replays return the existing value
   * only when its durable content is identical; later human edits are never
   * overwritten by a resumed onboarding run.
   */
  async putIdempotent(
    slugValue: string,
    input: UpsertMemoryInput,
    authorization: AuthorizationContext,
    idempotencyKey: string,
  ): Promise<Memory> {
    const context = await this.#context(authorization, 'memory-write');
    const key = requiredText(idempotencyKey, 'idempotencyKey', 256);
    const workspaceId = requireActiveWorkspace(context);
    const storedIdempotencyKey = `${workspaceId}\u0000${context.principalId}\u0000${key}`;
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
    const scope = normalizeVisibilityScope(
      input.visibility ?? defaultVisibility(context),
    );
    const now = this.#clock().toISOString();
    return observed(
      this.options.observe,
      {
        operation: 'memory.upsert',
        principalId: context.principalId,
      },
      async () => {
        const insert = this.db
          .prepare(
            `INSERT INTO workshop_memories
             (slug, idempotency_key, description, content, created_at, updated_at, revision,
              installation_id, owner_principal_id, workspace_id, visibility_scope,
              authorization_revision)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING
             RETURNING *`,
          )
          .bind(
            slug,
            storedIdempotencyKey,
            description,
            content,
            now,
            now,
            context.installationId,
            context.principalId,
            workspaceId,
            serializeVisibilityScope(scope),
            context.authorizationRevision,
          );
        const inserted =
          await this.options.authorization.commitMemoryMutation<MemoryRow>(
            this.db,
            context,
            insert,
          );
        if (inserted) {
          authorizeRecord(toAuthorizationRecord(inserted), context);
          return toMemory(inserted);
        }
        const visibility = visibilitySql('workshop_memories', context);
        const existing = await this.db
          .prepare(
            `SELECT * FROM workshop_memories
             WHERE idempotency_key = ? AND ${visibility.sql}`,
          )
          .bind(storedIdempotencyKey, ...visibility.values)
          .first<MemoryRow>();
        if (
          existing?.slug === slug &&
          existing.description === description &&
          existing.content === content &&
          existing.visibility_scope === serializeVisibilityScope(scope)
        ) {
          await this.#recheck(existing, context);
          return toMemory(existing);
        }
        throw new WorkshopError(
          'conflict',
          `Idempotent memory input conflicts with existing content`,
        );
      },
    );
  }

  async #context(
    authorization: AuthorizationContext,
    capability: 'read' | 'memory-write' = 'read',
  ): Promise<AuthorizationContext> {
    const context = await requireCurrentAuthorization(
      this.options.authorization,
      authorization,
    );
    requireCapability(context, capability);
    return context;
  }

  async #recheck(
    hydrated: MemoryRow,
    context: AuthorizationContext,
  ): Promise<void> {
    await this.#recheckAll([hydrated], context);
  }

  async #recheckAll(
    hydrated: readonly MemoryAuthorizationRow[],
    context: AuthorizationContext,
  ): Promise<void> {
    await requireCurrentAuthorization(this.options.authorization, context);
    if (hydrated.length === 0) return;
    const predicate = visibilitySql('workshop_memories', context);
    const current = new Map<string, MemoryAuthorizationRow>();
    for (
      let offset = 0;
      offset < hydrated.length;
      offset += AUTHORIZED_ID_BATCH
    ) {
      const batch = hydrated.slice(offset, offset + AUTHORIZED_ID_BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const result = await this.db
        .prepare(
          `SELECT slug, revision, installation_id, authorization_revision, visibility_scope
           FROM workshop_memories
           WHERE slug IN (${placeholders}) AND ${predicate.sql}`,
        )
        .bind(...batch.map(({ slug }) => slug), ...predicate.values)
        .all<MemoryAuthorizationRow>();
      for (const row of result.results) current.set(row.slug, row);
    }
    for (const candidate of hydrated) {
      const row = current.get(candidate.slug);
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

  async #policyRow(
    slug: string,
    context: AuthorizationContext,
  ): Promise<Pick<
    MemoryRow,
    | 'owner_principal_id'
    | 'installation_id'
    | 'authorization_revision'
    | 'visibility_scope'
  > | null> {
    const predicate = visibilitySql('workshop_memories', context);
    const row = await this.db
      .prepare(
        `SELECT owner_principal_id, installation_id, authorization_revision,
                visibility_scope
         FROM workshop_memories WHERE slug = ? AND ${predicate.sql}`,
      )
      .bind(slug, ...predicate.values)
      .first<
        Pick<
          MemoryRow,
          | 'owner_principal_id'
          | 'installation_id'
          | 'authorization_revision'
          | 'visibility_scope'
        >
      >();
    if (row) return row;
    const inaccessible = await this.db
      .prepare(
        `SELECT 1 AS present FROM workshop_memories
         WHERE installation_id = ? AND slug = ?`,
      )
      .bind(context.installationId, slug)
      .first<{ present: number }>();
    if (inaccessible) throw denied();
    return null;
  }
}

type MemoryAuthorizationRow = Pick<
  MemoryRow,
  | 'slug'
  | 'revision'
  | 'installation_id'
  | 'authorization_revision'
  | 'visibility_scope'
>;

function toMemory(row: MemoryRow): Memory {
  const authorization = toAuthorizationRecord(row);
  if (!row.owner_principal_id || !row.workspace_id) throw denied();
  return {
    slug: row.slug,
    description: row.description,
    content: row.content,
    createdAt: normalizeSqlDate(row.created_at),
    updatedAt: normalizeSqlDate(row.updated_at),
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
    MemoryRow,
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

function revisionPrecondition(
  input: UpsertMemoryInput,
): ResolvedRevisionPrecondition | undefined {
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
  return expectedUpdatedAt === undefined
    ? undefined
    : { column: 'updated_at', value: expectedUpdatedAt };
}

function normalizeSqlDate(value: string): string {
  const parsed = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(parsed).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}
