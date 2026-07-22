import { WorkshopError } from '../protocol/errors.js';
import type {
  Memory,
  MemoryFilters,
  MemoryPage,
  MemoryRevision,
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
  commitWorkshopCanonicalSearchMutationV1,
  type WorkshopSearchDomainV1,
} from './search.js';
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
  title: string | null;
  description: string;
  content: string;
  applicability_json: string;
  provenance_json: string;
  language: string;
  attribution_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
  policy_revision: number;
  idempotency_key: string | null;
  installation_id: string | null;
  owner_principal_id: string | null;
  workspace_id: string | null;
  visibility_scope: string | null;
  authorization_revision: number | null;
  deleted_at: string | null;
  search_event_id: string | null;
  search_event_sequence: number | null;
}

const AUTHORIZED_ID_BATCH = 80;

export interface MemoryServiceOptions {
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  createId?: () => string;
  observe?: ObserveWorkshop;
  authorization: WorkshopAuthorizationAuthority;
  cursorCodec: WorkshopCursorCodec;
  search?: WorkshopSearchDomainV1;
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
        `SELECT * FROM workshop_memories WHERE slug = ? AND deleted_at IS NULL AND ${predicate.sql}`,
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
           WHERE deleted_at IS NULL AND ${clauses.join(' AND ')}
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
           WHERE slug IN (${placeholders}) AND deleted_at IS NULL AND ${predicate.sql}`,
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
    const title =
      input.title === undefined
        ? undefined
        : requiredText(input.title, 'title', this.#limits.maxDescriptionBytes);
    const applicability =
      input.applicability === undefined
        ? undefined
        : jsonObject(
            input.applicability,
            'applicability',
            this.#limits.maxDescriptionBytes,
          );
    const provenance =
      input.provenance === undefined
        ? undefined
        : jsonObject(
            input.provenance,
            'provenance',
            this.#limits.maxDescriptionBytes,
          );
    const language =
      input.language === undefined
        ? undefined
        : requiredText(input.language, 'language', 64);
    const attribution =
      input.attribution === undefined
        ? undefined
        : jsonObject(
            input.attribution,
            'attribution',
            this.#limits.maxDescriptionBytes,
          );
    const expected = revisionPrecondition(input);
    const predicate = visibilitySql('workshop_memories', context);
    const current = await this.db
      .prepare(
        `SELECT * FROM workshop_memories WHERE installation_id = ? AND slug = ?
         AND deleted_at IS NULL AND ${predicate.sql}`,
      )
      .bind(context.installationId, slug, ...predicate.values)
      .first<MemoryRow>();
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
    const now = this.#clock().toISOString();
    return observed(
      this.options.observe,
      { operation: 'memory.upsert', principalId: context.principalId },
      async () => {
        const currentMemory = current ? toMemory(current) : null;
        const scope =
          requestedScope ??
          currentMemory?.visibility ??
          defaultVisibility(context);
        const policyChanged = currentMemory
          ? serializeVisibilityScope(scope) !==
            serializeVisibilityScope(currentMemory.visibility)
          : false;
        const next: Memory = {
          slug,
          title: title ?? currentMemory?.title ?? description,
          description,
          content,
          applicability: applicability ?? currentMemory?.applicability ?? {},
          provenance: provenance ?? currentMemory?.provenance ?? {},
          language: language ?? currentMemory?.language ?? 'en',
          attribution: attribution ?? currentMemory?.attribution ?? {},
          createdAt: currentMemory?.createdAt ?? now,
          updatedAt: currentMemory
            ? nextTimestamp(now, currentMemory.updatedAt)
            : now,
          revision: (currentMemory?.revision ?? 0) + 1,
          policyRevision: currentMemory
            ? currentMemory.policyRevision + (policyChanged ? 1 : 0)
            : 1,
          installationId: context.installationId,
          ownerPrincipalId:
            currentMemory?.ownerPrincipalId ?? context.principalId,
          workspaceId: currentMemory?.workspaceId ?? workspaceId,
          visibility: scope,
          authorizationRevision: context.authorizationRevision,
        };
        const eventId = crypto.randomUUID();
        const row = currentMemory
          ? await this.#commitCanonical(
              context,
              next,
              policyChanged ? 'memory.policy' : 'memory.update',
              await this.#predecessor(slug, context),
              {
                sql: `UPDATE workshop_memories SET title = ?, description = ?, content = ?,
                  applicability_json = ?, provenance_json = ?, language = ?, attribution_json = ?,
                  visibility_scope = ?, authorization_revision = ?, policy_revision = ?, revision = ?,
                  updated_at = ?, search_event_id = ?, search_event_sequence = NULL
                  WHERE installation_id = ? AND slug = ? AND revision = ? AND deleted_at IS NULL
                    ${expected ? `AND ${expected.column} = ?` : ''} AND ${predicate.sql} RETURNING *`,
                values: [
                  next.title,
                  next.description,
                  next.content,
                  JSON.stringify(next.applicability),
                  JSON.stringify(next.provenance),
                  next.language,
                  JSON.stringify(next.attribution),
                  serializeVisibilityScope(scope),
                  context.authorizationRevision,
                  next.policyRevision,
                  next.revision,
                  next.updatedAt,
                  eventId,
                  context.installationId,
                  slug,
                  currentMemory.revision,
                  ...(expected ? [expected.value] : []),
                  ...predicate.values,
                ],
              },
              eventId,
            )
          : await this.#commitCanonical(
              context,
              next,
              'memory.create',
              null,
              {
                sql: `INSERT INTO workshop_memories
                  (slug, title, description, content, applicability_json, provenance_json,
                   language, attribution_json, created_at, updated_at, revision, policy_revision,
                   installation_id, owner_principal_id, workspace_id, visibility_scope,
                   authorization_revision, search_event_id, search_event_sequence)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, NULL) RETURNING *`,
                values: [
                  slug,
                  next.title,
                  description,
                  content,
                  JSON.stringify(next.applicability),
                  JSON.stringify(next.provenance),
                  next.language,
                  JSON.stringify(next.attribution),
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
        if (!row) throw new WorkshopError('conflict', 'Memory state changed');
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
        const visibility = visibilitySql('workshop_memories', context);
        const existing = await this.db
          .prepare(
            `SELECT * FROM workshop_memories
             WHERE idempotency_key = ? AND deleted_at IS NULL AND ${visibility.sql}`,
          )
          .bind(storedIdempotencyKey, ...visibility.values)
          .first<MemoryRow>();
        if (existing) {
          if (
            existing.slug === slug &&
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
        }
        const occupied = await this.db
          .prepare(
            `SELECT slug FROM workshop_memories
             WHERE installation_id = ? AND slug = ? AND deleted_at IS NULL
               AND ${visibility.sql}`,
          )
          .bind(context.installationId, slug, ...visibility.values)
          .first<{ slug: string }>();
        if (occupied)
          throw new WorkshopError(
            'conflict',
            `Idempotent memory input conflicts with existing content`,
          );
        const eventId = crypto.randomUUID();
        const next: Memory = {
          slug,
          title: input.title ?? description,
          description,
          content,
          applicability: input.applicability ?? {},
          provenance: input.provenance ?? {},
          language: input.language ?? 'en',
          attribution: input.attribution ?? {},
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
        let inserted: MemoryRow | null;
        try {
          inserted = await this.#commitCanonical(
            context,
            next,
            'memory.create',
            null,
            {
              sql: `INSERT INTO workshop_memories
             (slug, idempotency_key, title, description, content, applicability_json,
              provenance_json, language, attribution_json, created_at, updated_at, revision,
              policy_revision, installation_id, owner_principal_id, workspace_id, visibility_scope,
              authorization_revision, search_event_id, search_event_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, NULL) RETURNING *`,
              values: [
                slug,
                storedIdempotencyKey,
                next.title,
                description,
                content,
                JSON.stringify(next.applicability),
                JSON.stringify(next.provenance),
                next.language,
                JSON.stringify(next.attribution),
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
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/UNIQUE constraint failed/iu.test(error.message)
          )
            throw error;
          inserted = null;
        }
        if (inserted) {
          authorizeRecord(toAuthorizationRecord(inserted), context);
          return toMemory(inserted);
        }
        const raced = await this.db
          .prepare(
            `SELECT * FROM workshop_memories
             WHERE idempotency_key = ? AND ${visibility.sql}`,
          )
          .bind(storedIdempotencyKey, ...visibility.values)
          .first<MemoryRow>();
        if (
          raced?.slug === slug &&
          raced.description === description &&
          raced.content === content &&
          raced.visibility_scope === serializeVisibilityScope(scope)
        ) {
          await this.#recheck(raced, context);
          return toMemory(raced);
        }
        throw new WorkshopError(
          'conflict',
          `Idempotent memory input conflicts with existing content`,
        );
      },
    );
  }

  async delete(
    slugValue: string,
    expectedRevision: number,
    authorization: AuthorizationContext,
  ): Promise<void> {
    const context = await this.#context(authorization, 'memory-write');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw validation('expectedRevision must be a positive safe integer');
    const slug = memorySlug(slugValue);
    const predicate = visibilitySql('workshop_memories', context);
    const row = await this.db
      .prepare(
        `SELECT * FROM workshop_memories WHERE installation_id = ? AND slug = ?
         AND deleted_at IS NULL AND ${predicate.sql}`,
      )
      .bind(context.installationId, slug, ...predicate.values)
      .first<MemoryRow>();
    if (!row) throw denied();
    await this.#recheck(row, context);
    const current = toMemory(row);
    if (current.revision !== expectedRevision)
      throw new WorkshopError('conflict', 'Memory state changed');
    const now = this.#clock().toISOString();
    const updatedAt = nextTimestamp(now, current.updatedAt);
    const eventId = crypto.randomUUID();
    const deleted = {
      ...current,
      revision: current.revision + 1,
      updatedAt,
    };
    const receipt = await commitWorkshopCanonicalSearchMutationV1(
      this.#search(),
      {
        context,
        eventId,
        sourceId: current.slug,
        operation: 'delete',
        changeClass: 'memory.delete',
        sourceRevision: deleted.revision,
        sourcePolicyRevision: current.policyRevision,
        predecessor: await this.#predecessor(current.slug, context),
        canonicalPostState: { ...deleted, deletedAt: updatedAt },
        statements: [
          {
            sql: `UPDATE workshop_memories SET deleted_at = ?, revision = ?, updated_at = ?,
              authorization_revision = ?, search_event_id = ?, search_event_sequence = NULL
              WHERE installation_id = ? AND slug = ? AND revision = ? AND deleted_at IS NULL`,
            values: [
              updatedAt,
              deleted.revision,
              updatedAt,
              context.authorizationRevision,
              eventId,
              context.installationId,
              current.slug,
              current.revision,
            ],
          },
          this.#revisionStatement(
            deleted,
            context.principalId,
            eventId,
            updatedAt,
          ),
        ],
      },
    );
    if (
      (receipt.results[0]?.meta as { changes?: number } | undefined)
        ?.changes === 0
    )
      throw new WorkshopError('conflict', 'Memory state changed');
  }

  async history(
    slugValue: string,
    authorization: AuthorizationContext,
  ): Promise<MemoryRevision[]> {
    const current = await this.get(slugValue, authorization);
    const rows = await this.db
      .prepare(
        `SELECT memory_id, revision, snapshot_json, actor_principal_id, event_id, created_at
         FROM workshop_memory_revisions
         WHERE installation_id = ? AND memory_id = ? ORDER BY revision DESC LIMIT 200`,
      )
      .bind(current.installationId, current.slug)
      .all<{
        memory_id: string;
        revision: number;
        snapshot_json: string;
        actor_principal_id: string;
        event_id: string;
        created_at: string;
      }>();
    return rows.results.map((row) => ({
      memoryId: row.memory_id,
      revision: row.revision,
      memory: JSON.parse(row.snapshot_json) as Memory,
      actorPrincipalId: row.actor_principal_id,
      eventId: row.event_id,
      createdAt: normalizeSqlDate(row.created_at),
    }));
  }

  #search(): WorkshopSearchDomainV1 {
    if (!this.options.search)
      throw new WorkshopError(
        'internal_error',
        'Canonical Memory search producer is not registered',
      );
    return this.options.search;
  }

  async #predecessor(
    slug: string,
    context: AuthorizationContext,
  ): Promise<{ eventId: string; sequence: number }> {
    const row = await this.db
      .prepare(
        `SELECT current_event_id AS event_id, current_event_sequence AS sequence
         FROM taproot_unified_search_source_registry
         WHERE installation_id = ? AND source_kind = 'memory' AND source_id = ?`,
      )
      .bind(context.installationId, slug)
      .first<{ event_id: string; sequence: number }>();
    if (!row || !Number.isSafeInteger(Number(row.sequence))) throw denied();
    return { eventId: row.event_id, sequence: Number(row.sequence) };
  }

  #revisionStatement(
    memory: Memory,
    actor: string,
    eventId: string,
    now: string,
  ) {
    return {
      sql: `INSERT INTO workshop_memory_revisions
        (installation_id, memory_id, revision, snapshot_json, actor_principal_id, event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values: [
        memory.installationId,
        memory.slug,
        memory.revision,
        JSON.stringify(memory),
        actor,
        eventId,
        now,
      ],
    };
  }

  async #commitCanonical(
    context: AuthorizationContext,
    next: Memory,
    changeClass: string,
    predecessor: { eventId: string; sequence: number } | null,
    mutation: { sql: string; values: readonly unknown[] },
    eventId: string,
  ): Promise<MemoryRow | null> {
    const receipt = await commitWorkshopCanonicalSearchMutationV1(
      this.#search(),
      {
        context,
        eventId,
        sourceId: next.slug,
        operation: 'upsert',
        changeClass,
        sourceRevision: next.revision,
        sourcePolicyRevision: next.policyRevision,
        predecessor,
        canonicalPostState: next,
        statements: [
          mutation,
          this.#revisionStatement(
            next,
            context.principalId,
            eventId,
            next.updatedAt,
          ),
        ],
      },
    );
    return (receipt.results[0]?.results[0] as MemoryRow | undefined) ?? null;
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
    title: row.title ?? row.description,
    description: row.description,
    content: row.content,
    applicability: JSON.parse(row.applicability_json) as Record<
      string,
      unknown
    >,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    language: row.language,
    attribution: JSON.parse(row.attribution_json) as Record<string, unknown>,
    createdAt: normalizeSqlDate(row.created_at),
    updatedAt: normalizeSqlDate(row.updated_at),
    revision: row.revision,
    policyRevision: row.policy_revision,
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

function nextTimestamp(candidate: string, current: string): string {
  const candidateTime = new Date(candidate).getTime();
  const currentTime = new Date(current).getTime();
  return new Date(Math.max(candidateTime, currentTime + 1)).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
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
