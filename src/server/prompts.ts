import type {
  CreatePromptInput,
  Prompt,
  PromptAttribution,
  PromptFilters,
  PromptPage,
  PromptRevision,
  UpdatePromptInput,
} from '../protocol/prompts.js';
import type { RevisionHistoryOptions } from '../protocol/tasks.js';
import { WorkshopError } from '../protocol/errors.js';
import type { D1DatabaseLike } from './database.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
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
import { pageLimit, requiredText, validation } from './validation.js';

interface PromptRow {
  installation_id: string;
  id: string;
  name: string;
  title: string;
  prompt_text: string;
  scope: string | null;
  role: string | null;
  variables_json: string;
  active: number;
  priority: number;
  sort_order: number;
  language: string;
  attribution_json: string;
  revision: number;
  policy_revision: number;
  owner_principal_id: string;
  workspace_id: string;
  visibility_scope: string;
  authorization_revision: number;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
  deleted_at: string | null;
  search_event_id: string | null;
  search_event_sequence: number | null;
}

interface PromptRevisionRow {
  prompt_id: string;
  revision: number;
  snapshot_json: string;
  actor_principal_id: string;
  event_id: string;
  created_at: string;
}

export interface PromptServiceOptions {
  authorization: WorkshopAuthorizationAuthority;
  cursorCodec: WorkshopCursorCodec;
  search: WorkshopSearchDomainV1;
  limits?: Partial<WorkshopLimits>;
  clock?: () => Date;
  createId?: () => string;
}

export class PromptService {
  readonly #limits: Readonly<WorkshopLimits>;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    readonly db: D1DatabaseLike,
    private readonly options: PromptServiceOptions,
  ) {
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async get(
    idValue: string,
    authorization: AuthorizationContext,
  ): Promise<Prompt> {
    const context = await this.#context(authorization);
    const row = await this.#row(idValue, context);
    if (!row) throw denied();
    await this.#recheck(row, context);
    return toPrompt(row);
  }

  async list(
    filters: PromptFilters = {},
    authorization: AuthorizationContext,
  ): Promise<PromptPage> {
    const context = await this.#context(authorization);
    const limit = pageLimit(filters.limit, this.#limits);
    const text = filters.text?.trim() || null;
    const binding: CursorBinding = {
      operation: 'prompt.list',
      domain: 'prompt',
      query: 'updated_at_desc__id_asc.v1',
      filters: {
        text,
        active: filters.active ?? null,
        role: filters.role ?? null,
        scope: filters.scope ?? null,
        limit,
      },
    };
    const predicate = visibilitySql('workshop_prompts', context);
    const clauses = [predicate.sql, 'deleted_at IS NULL'];
    const values: unknown[] = [...predicate.values];
    if (text) {
      const pattern = `%${escapeLike(text)}%`;
      clauses.push(
        "(name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR prompt_text LIKE ? ESCAPE '\\')",
      );
      values.push(pattern, pattern, pattern);
    }
    if (filters.active !== undefined) {
      clauses.push('active = ?');
      values.push(filters.active ? 1 : 0);
    }
    if (filters.role) {
      clauses.push('role = ?');
      values.push(filters.role);
    }
    if (filters.scope) {
      clauses.push('scope = ?');
      values.push(filters.scope);
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
          `SELECT id, revision, updated_at FROM workshop_prompts
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
    if (entries.length === 0) return { items: [], cursor: null };
    const placeholders = entries.map(() => '?').join(', ');
    const rows = await this.db
      .prepare(
        `SELECT * FROM workshop_prompts WHERE id IN (${placeholders})
         AND deleted_at IS NULL AND ${predicate.sql}`,
      )
      .bind(...entries.map(({ id }) => id), ...predicate.values)
      .all<PromptRow>();
    const byId = new Map(rows.results.map((row) => [row.id, row]));
    const ordered = entries.map((entry) => {
      const row = byId.get(entry.id);
      if (
        !row ||
        row.revision !== entry.revision ||
        normalizeDate(row.updated_at) !== entry.updatedAt
      )
        throw denied();
      return row;
    });
    await Promise.all(ordered.map((row) => this.#recheck(row, context)));
    await requireUnchangedCursorState(
      this.options.authorization,
      context,
      snapshot.state,
    );
    const visible = ordered.slice(0, limit);
    return {
      items: visible.map(toPrompt),
      cursor:
        ordered.length > limit
          ? await encodeCursor(
              this.options.cursorCodec,
              snapshot,
              snapshot.start + limit,
            )
          : null,
    };
  }

  async create(
    input: CreatePromptInput,
    authorization: AuthorizationContext,
  ): Promise<Prompt> {
    const context = await this.#context(authorization, 'prompt-write');
    const workspaceId = requireActiveWorkspace(context);
    const now = this.#clock().toISOString();
    const id = input.id ? requiredText(input.id, 'id', 256) : this.#createId();
    const normalized = normalizeInput(input, this.#limits);
    const visibility = normalizeVisibilityScope(
      input.visibility ?? defaultVisibility(context),
    );
    const eventId = crypto.randomUUID();
    const prompt: Prompt = {
      id,
      ...normalized,
      active: input.active ?? true,
      revision: 1,
      policyRevision: 1,
      installationId: context.installationId,
      ownerPrincipalId: context.principalId,
      workspaceId,
      visibility,
      authorizationRevision: context.authorizationRevision,
      createdAt: now,
      updatedAt: now,
      ...(!(input.active ?? true) ? { deactivatedAt: now } : {}),
    };
    const statements = [
      {
        sql: `INSERT INTO workshop_prompts
          (installation_id, id, name, title, prompt_text, scope, role, variables_json,
           active, priority, sort_order, language, attribution_json, revision,
           policy_revision, owner_principal_id, workspace_id, visibility_scope,
           authorization_revision, created_at, updated_at, deactivated_at,
           search_event_id, search_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          RETURNING *`,
        values: [
          context.installationId,
          id,
          prompt.name,
          prompt.title,
          prompt.promptText,
          prompt.scope ?? null,
          prompt.role ?? null,
          JSON.stringify(prompt.variables),
          prompt.active ? 1 : 0,
          prompt.priority,
          prompt.order,
          prompt.language,
          JSON.stringify(prompt.attribution),
          context.principalId,
          workspaceId,
          serializeVisibilityScope(visibility),
          context.authorizationRevision,
          now,
          now,
          prompt.deactivatedAt ?? null,
          eventId,
        ],
      },
      revisionStatement(prompt, context.principalId, eventId, now),
    ];
    try {
      const receipt = await commitWorkshopCanonicalSearchMutationV1(
        this.options.search,
        {
          context,
          eventId,
          sourceId: id,
          operation: 'upsert',
          changeClass: 'prompt.create',
          sourceRevision: 1,
          sourcePolicyRevision: 1,
          predecessor: null,
          canonicalPostState: prompt,
          statements,
        },
      );
      const row = receipt.results[0]?.results[0] as PromptRow | undefined;
      if (!row)
        throw new WorkshopError('internal_error', 'Prompt creation failed');
      return toPrompt(row);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed/iu.test(error.message)
      )
        throw new WorkshopError('conflict', 'Prompt id or name already exists');
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdatePromptInput,
    authorization: AuthorizationContext,
  ): Promise<Prompt> {
    const context = await this.#context(authorization, 'prompt-write');
    validateRevision(input.expectedRevision);
    const current = await this.#getForMutation(id, context);
    if (current.revision !== input.expectedRevision)
      throw new WorkshopError('conflict', 'Prompt state changed');
    const normalized = normalizeInput(
      {
        name: input.name ?? current.name,
        title: input.title ?? current.title,
        promptText: input.promptText ?? current.promptText,
        ...(input.scope === null
          ? {}
          : input.scope !== undefined
            ? { scope: input.scope }
            : current.scope
              ? { scope: current.scope }
              : {}),
        ...(input.role === null
          ? {}
          : input.role !== undefined
            ? { role: input.role }
            : current.role
              ? { role: current.role }
              : {}),
        variables: input.variables ?? current.variables,
        active: input.active ?? current.active,
        priority: input.priority ?? current.priority,
        order: input.order ?? current.order,
        language: input.language ?? current.language,
        attribution: input.attribution ?? current.attribution,
      },
      this.#limits,
    );
    const visibility = input.visibility
      ? normalizeVisibilityScope(input.visibility)
      : current.visibility;
    const policyChanged =
      serializeVisibilityScope(visibility) !==
      serializeVisibilityScope(current.visibility);
    const now = this.#clock().toISOString();
    const eventId = crypto.randomUUID();
    const nextBase: Prompt = {
      ...current,
      ...normalized,
      active: input.active ?? current.active,
      visibility,
      revision: current.revision + 1,
      policyRevision: current.policyRevision + (policyChanged ? 1 : 0),
      authorizationRevision: context.authorizationRevision,
      updatedAt: nextTimestamp(now, current.updatedAt),
    };
    const next: Prompt = nextBase.active
      ? omitDeactivatedAt(nextBase)
      : {
          ...nextBase,
          deactivatedAt: current.deactivatedAt ?? nextBase.updatedAt,
        };
    const sequence = await this.#sequence(current.id, context);
    const statements = [
      {
        sql: `UPDATE workshop_prompts SET
          name = ?, title = ?, prompt_text = ?, scope = ?, role = ?, variables_json = ?,
          active = ?, priority = ?, sort_order = ?, language = ?, attribution_json = ?,
          visibility_scope = ?, authorization_revision = ?, revision = ?, policy_revision = ?,
          updated_at = ?, deactivated_at = ?, search_event_id = ?,
          search_event_sequence = NULL
          WHERE installation_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL
          RETURNING *`,
        values: [
          next.name,
          next.title,
          next.promptText,
          next.scope ?? null,
          next.role ?? null,
          JSON.stringify(next.variables),
          next.active ? 1 : 0,
          next.priority,
          next.order,
          next.language,
          JSON.stringify(next.attribution),
          serializeVisibilityScope(next.visibility),
          context.authorizationRevision,
          next.revision,
          next.policyRevision,
          next.updatedAt,
          next.deactivatedAt ?? null,
          eventId,
          context.installationId,
          id,
          current.revision,
        ],
      },
      revisionStatement(next, context.principalId, eventId, next.updatedAt),
    ];
    const receipt = await commitWorkshopCanonicalSearchMutationV1(
      this.options.search,
      {
        context,
        eventId,
        sourceId: id,
        operation: 'upsert',
        changeClass: policyChanged ? 'prompt.policy' : 'prompt.update',
        sourceRevision: next.revision,
        sourcePolicyRevision: next.policyRevision,
        predecessor: sequence,
        canonicalPostState: next,
        statements,
      },
    );
    const row = receipt.results[0]?.results[0] as PromptRow | undefined;
    if (!row) throw new WorkshopError('conflict', 'Prompt state changed');
    return toPrompt(row);
  }

  async deactivate(
    id: string,
    expectedRevision: number,
    authorization: AuthorizationContext,
  ): Promise<Prompt> {
    return this.update(id, { expectedRevision, active: false }, authorization);
  }

  async delete(
    id: string,
    expectedRevision: number,
    authorization: AuthorizationContext,
  ): Promise<void> {
    const context = await this.#context(authorization, 'prompt-write');
    validateRevision(expectedRevision);
    const current = await this.#getForMutation(id, context);
    if (current.revision !== expectedRevision)
      throw new WorkshopError('conflict', 'Prompt state changed');
    const now = this.#clock().toISOString();
    const eventId = crypto.randomUUID();
    const sequence = await this.#sequence(id, context);
    const updatedAt = nextTimestamp(now, current.updatedAt);
    const deleted = {
      ...current,
      active: false,
      revision: current.revision + 1,
      updatedAt,
      deactivatedAt: current.deactivatedAt ?? updatedAt,
      deletedAt: updatedAt,
    };
    const receipt = await commitWorkshopCanonicalSearchMutationV1(
      this.options.search,
      {
        context,
        eventId,
        sourceId: id,
        operation: 'delete',
        changeClass: 'prompt.delete',
        sourceRevision: deleted.revision,
        sourcePolicyRevision: current.policyRevision,
        predecessor: sequence,
        canonicalPostState: deleted,
        statements: [
          {
            sql: `UPDATE workshop_prompts SET active = 0, deactivated_at = COALESCE(deactivated_at, ?),
              deleted_at = ?, revision = ?, updated_at = ?,
              authorization_revision = ?, search_event_id = ?, search_event_sequence = NULL
              WHERE installation_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`,
            values: [
              deleted.deactivatedAt,
              deleted.deletedAt,
              deleted.revision,
              deleted.updatedAt,
              context.authorizationRevision,
              eventId,
              context.installationId,
              id,
              current.revision,
            ],
          },
          revisionStatement(deleted, context.principalId, eventId, updatedAt),
        ],
      },
    );
    if (
      (receipt.results[0]?.meta as { changes?: number } | undefined)
        ?.changes === 0
    )
      throw new WorkshopError('conflict', 'Prompt state changed');
  }

  async history(
    id: string,
    authorization: AuthorizationContext,
    options: RevisionHistoryOptions = {},
  ): Promise<PromptRevision[]> {
    const context = await this.#context(authorization);
    const current = await this.#row(id, context);
    if (!current) throw denied();
    await this.#recheck(current, context);
    const limit = pageLimit(
      options.limit ?? this.#limits.maxPageSize,
      this.#limits,
    );
    const rows = await this.db
      .prepare(
        `SELECT * FROM workshop_prompt_revisions
         WHERE installation_id = ? AND prompt_id = ?
         ORDER BY revision DESC LIMIT ?`,
      )
      .bind(context.installationId, current.id, limit)
      .all<PromptRevisionRow>();
    const revisions = rows.results.map((row, index) => {
      const prompt = parsePromptRevision(
        row.snapshot_json,
        row.prompt_id,
        row.revision,
      );
      if (row.revision !== current.revision - index) throw denied();
      authorizeRecord(prompt, context);
      return {
        promptId: row.prompt_id,
        revision: row.revision,
        prompt,
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

  async #sequence(
    id: string,
    context: AuthorizationContext,
  ): Promise<{ eventId: string; sequence: number }> {
    const row = await this.db
      .prepare(
        `SELECT current_event_id AS search_event_id,
                current_event_sequence AS search_event_sequence
         FROM taproot_unified_search_source_registry
         WHERE installation_id = ? AND source_kind = 'prompt' AND source_id = ?`,
      )
      .bind(context.installationId, id)
      .first<Pick<PromptRow, 'search_event_id' | 'search_event_sequence'>>();
    if (!row?.search_event_id || row.search_event_sequence === null)
      throw denied();
    return {
      eventId: row.search_event_id,
      sequence: row.search_event_sequence,
    };
  }

  async #row(idValue: string, context: AuthorizationContext) {
    const id = requiredText(idValue, 'id', 256);
    const predicate = visibilitySql('workshop_prompts', context);
    return this.db
      .prepare(
        `SELECT * FROM workshop_prompts WHERE installation_id = ? AND id = ?
         AND deleted_at IS NULL AND ${predicate.sql}`,
      )
      .bind(context.installationId, id, ...predicate.values)
      .first<PromptRow>();
  }

  async #recheck(row: PromptRow, context: AuthorizationContext): Promise<void> {
    await requireCurrentAuthorization(this.options.authorization, context);
    const current = await this.#row(row.id, context);
    if (
      !current ||
      current.revision !== row.revision ||
      current.policy_revision !== row.policy_revision ||
      current.visibility_scope !== row.visibility_scope
    )
      throw denied();
    authorizeRecord(
      {
        installationId: current.installation_id,
        authorizationRevision: current.authorization_revision,
        visibility: normalizeVisibilityScope(
          JSON.parse(current.visibility_scope) as never,
        ),
      },
      context,
    );
  }

  async #getForMutation(
    id: string,
    context: AuthorizationContext,
  ): Promise<Prompt> {
    const row = await this.#row(id, context);
    if (!row) throw denied();
    await this.#recheck(row, context);
    return toPrompt(row);
  }

  async #context(
    authorization: AuthorizationContext,
    capability: 'read' | 'prompt-write' = 'read',
  ): Promise<AuthorizationContext> {
    const context = await requireCurrentAuthorization(
      this.options.authorization,
      authorization,
    );
    requireCapability(context, capability);
    return context;
  }
}

function normalizeInput(
  input: Omit<CreatePromptInput, 'id' | 'visibility'>,
  limits: Readonly<WorkshopLimits>,
) {
  if (!input || typeof input !== 'object')
    throw validation('Prompt input is required');
  const name = requiredText(input.name, 'name', 256);
  const title = requiredText(
    input.title ?? name,
    'title',
    limits.maxDescriptionBytes,
  );
  const promptText = requiredText(
    input.promptText,
    'promptText',
    limits.maxPromptBytes,
  );
  const scope = optional(input.scope, 'scope', 256);
  const role = optional(input.role, 'role', 256);
  const language = requiredText(input.language ?? 'en', 'language', 64);
  const priority = boundedInteger(input.priority ?? 0, 'priority');
  const order = boundedInteger(input.order ?? 0, 'order');
  const variables = object(
    input.variables ?? {},
    'variables',
    limits.maxPromptBytes,
  );
  const attribution = object(
    input.attribution ?? {},
    'attribution',
    limits.maxDescriptionBytes,
  ) as PromptAttribution;
  return {
    name,
    title,
    promptText,
    ...(scope ? { scope } : {}),
    ...(role ? { role } : {}),
    variables,
    active: input.active ?? true,
    priority,
    order,
    language,
    attribution,
  };
}

function revisionStatement(
  prompt: Prompt & { deletedAt?: string },
  actor: string,
  eventId: string,
  now: string,
) {
  return {
    sql: `INSERT INTO workshop_prompt_revisions
      (installation_id, prompt_id, revision, snapshot_json, actor_principal_id, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    values: [
      prompt.installationId,
      prompt.id,
      prompt.revision,
      JSON.stringify(prompt),
      actor,
      eventId,
      now,
    ],
  };
}

function toPrompt(row: PromptRow): Prompt {
  const visibility = normalizeVisibilityScope(
    JSON.parse(row.visibility_scope) as never,
  );
  if (serializeVisibilityScope(visibility) !== row.visibility_scope)
    throw denied();
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    promptText: row.prompt_text,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.role ? { role: row.role } : {}),
    variables: JSON.parse(row.variables_json) as Record<string, unknown>,
    active: row.active === 1,
    priority: row.priority,
    order: row.sort_order,
    language: row.language,
    attribution: JSON.parse(row.attribution_json) as PromptAttribution,
    revision: row.revision,
    policyRevision: row.policy_revision,
    installationId: row.installation_id,
    ownerPrincipalId: row.owner_principal_id,
    workspaceId: row.workspace_id,
    visibility,
    authorizationRevision: row.authorization_revision,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    ...(row.deactivated_at
      ? { deactivatedAt: normalizeDate(row.deactivated_at) }
      : {}),
  };
}

function parsePromptRevision(
  snapshot: string,
  promptId: string,
  revision: number,
): Prompt {
  let value: unknown;
  try {
    value = JSON.parse(snapshot);
  } catch {
    throw denied();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw denied();
  const prompt = value as Prompt;
  if (
    prompt.id !== promptId ||
    prompt.revision !== revision ||
    typeof prompt.installationId !== 'string' ||
    !Number.isSafeInteger(prompt.authorizationRevision) ||
    !prompt.visibility
  )
    throw denied();
  return prompt;
}

function object(
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

function optional(value: unknown, field: string, max: number) {
  return value === undefined ? undefined : requiredText(value, field, max);
}

function boundedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 1_000_000)
    throw validation(`${field} is invalid`);
  return value as number;
}

function validateRevision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw validation('expectedRevision must be a positive safe integer');
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

function omitDeactivatedAt(prompt: Prompt): Prompt {
  const { deactivatedAt: _deactivatedAt, ...active } = prompt;
  void _deactivatedAt;
  return active;
}
