import {
  defaultVisibility,
  normalizeAuthorizationContext,
  normalizeVisibilityScope,
  requireActiveWorkspace,
  requireCurrentAuthorizationState,
  requireSearchAdministration,
  serializeVisibilityScope,
  type AuthorizationContext,
  type VisibilityScopeV1,
  type WorkshopAuthorizationAuthority,
} from './authorization.js';
import type { WorkshopPersistence } from './database.js';
import { WorkshopError } from '../protocol/errors.js';

export interface WorkshopAuthorizationReadiness {
  ready: boolean;
  quarantinedTasks: number;
  quarantinedMemories: number;
}

export async function inspectWorkshopAuthorizationReadiness(
  db: WorkshopPersistence,
): Promise<WorkshopAuthorizationReadiness> {
  const [tasks, memories] = await Promise.all([
    quarantinedCount(db, 'workshop_tasks'),
    quarantinedCount(db, 'workshop_memories'),
  ]);
  return {
    ready: tasks === 0 && memories === 0,
    quarantinedTasks: tasks,
    quarantinedMemories: memories,
  };
}

export interface AuthorizationBackfillInput {
  domain: 'task' | 'memory';
  after?: string;
  limit?: number;
  visibility?: VisibilityScopeV1;
}

export interface AuthorizationBackfillResult {
  domain: 'task' | 'memory';
  updated: number;
  cursor: string | null;
  done: boolean;
}

/**
 * Explicit, bounded host migration for quarantined pre-authorization rows.
 * It is intentionally not wired to HTTP or MCP. The host must approve the
 * destination installation/workspace and provide exact search administration.
 */
export async function backfillWorkshopAuthorizationBatch(
  db: WorkshopPersistence,
  authority: WorkshopAuthorizationAuthority,
  rawContext: AuthorizationContext,
  input: AuthorizationBackfillInput,
): Promise<AuthorizationBackfillResult> {
  const context = normalizeAuthorizationContext(rawContext);
  const state = await requireCurrentAuthorizationState(authority, context);
  requireSearchAdministration(context);
  const workspaceId = requireActiveWorkspace(context);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new WorkshopError(
      'validation_failed',
      'Backfill limit must be an integer from 1 through 100',
    );
  const after = input.after ?? '0';
  if (typeof after !== 'string' || !/^\d+$/u.test(after) || after.length > 20)
    throw new WorkshopError('validation_failed', 'Invalid backfill cursor');
  const afterRowid = Number(after);
  if (!Number.isSafeInteger(afterRowid) || afterRowid < 0)
    throw new WorkshopError('validation_failed', 'Invalid backfill cursor');
  const scope = serializeVisibilityScope(
    normalizeVisibilityScope(input.visibility ?? defaultVisibility(context)),
  );
  const table =
    input.domain === 'task' ? 'workshop_tasks' : 'workshop_memories';
  const key = input.domain === 'task' ? 'id' : 'slug';
  const selected = await db
    .prepare(
      `SELECT rowid, ${key} AS key, installation_id, owner_principal_id,
              workspace_id, visibility_scope, authorization_revision
       FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
    )
    .bind(afterRowid, limit)
    .all<AuthorizationMetadataRow>();
  const scanned = selected.results ?? [];
  if (scanned.length === 0)
    return { domain: input.domain, updated: 0, cursor: null, done: true };
  const quarantined = scanned.filter((row) => !metadataReady(row));
  let updated = 0;
  if (quarantined.length > 0) {
    const mutations = quarantined.map((row) =>
      db
        .prepare(
          `UPDATE ${table}
           SET installation_id = ?, owner_principal_id = ?, workspace_id = ?,
               visibility_scope = ?, authorization_revision = ?
           WHERE rowid = ? AND installation_id IS ? AND owner_principal_id IS ?
             AND workspace_id IS ? AND visibility_scope IS ?
             AND authorization_revision IS ?
           RETURNING ${key} AS key`,
        )
        .bind(
          context.installationId,
          context.principalId,
          workspaceId,
          scope,
          context.authorizationRevision,
          row.rowid,
          row.installation_id,
          row.owner_principal_id,
          row.workspace_id,
          row.visibility_scope,
          row.authorization_revision,
        ),
    );
    const results =
      input.domain === 'task'
        ? await authority.commitTaskBackfill(db, context, state, mutations)
        : await authority.commitMemoryBackfill(db, context, state, mutations);
    updated = results.reduce(
      (count, result) => count + result.results.length,
      0,
    );
    if (updated !== quarantined.length)
      throw new WorkshopError(
        'conflict',
        'Authorization backfill changed concurrently',
      );
  }
  const cursor = String(scanned.at(-1)!.rowid);
  const more = await db
    .prepare(
      `SELECT 1 AS present FROM ${table}
       WHERE rowid > ? LIMIT 1`,
    )
    .bind(cursor)
    .first<{ present: number }>();
  return {
    domain: input.domain,
    updated,
    cursor: more ? cursor : null,
    done: !more,
  };
}

async function quarantinedCount(
  db: WorkshopPersistence,
  table: 'workshop_tasks' | 'workshop_memories',
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT rowid, '' AS key, installation_id, owner_principal_id,
              workspace_id, visibility_scope, authorization_revision
       FROM ${table}`,
    )
    .all<AuthorizationMetadataRow>();
  if (!rows.success)
    throw new WorkshopError(
      'internal_error',
      'Authorization readiness query failed',
    );
  return (rows.results ?? []).filter((row) => !metadataReady(row)).length;
}

interface AuthorizationMetadataRow {
  rowid: number;
  key: string;
  installation_id: string | null;
  owner_principal_id: string | null;
  workspace_id: string | null;
  visibility_scope: string | null;
  authorization_revision: number | null;
}

function metadataReady(row: AuthorizationMetadataRow): boolean {
  try {
    if (!row.visibility_scope) return false;
    normalizeAuthorizationContext({
      installationId: row.installation_id,
      principalId: row.owner_principal_id,
      activeWorkspaceId: row.workspace_id,
      workspaceIds: [row.workspace_id],
      capabilities: [],
      authorizationRevision: row.authorization_revision,
    } as never);
    const parsed = JSON.parse(row.visibility_scope) as VisibilityScopeV1;
    return serializeVisibilityScope(parsed) === row.visibility_scope;
  } catch {
    return false;
  }
}
