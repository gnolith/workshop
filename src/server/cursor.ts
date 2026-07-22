import { WorkshopError } from '../protocol/errors.js';
import {
  authorizationCursorKey,
  denied,
  requireCurrentAuthorizationState,
  type AuthorizationContext,
  type InstallationAuthorizationState,
  type WorkshopAuthorizationAuthority,
} from './authorization.js';
import type { D1DatabaseLike } from './database.js';

const MAX_CURSOR_LENGTH = 8_192;
const MAX_SNAPSHOT_ENTRIES = 1_000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const CLEANUP_BATCH = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface WorkshopCursorCodec {
  currentGeneration(): Promise<string>;
  digest(purpose: string, value: Uint8Array): Promise<string>;
  seal(generation: string, plaintext: Uint8Array): Promise<string>;
  open(generation: string, token: string): Promise<Uint8Array>;
}

export interface CursorBinding {
  operation: string;
  domain: 'task' | 'memory' | 'prompt';
  query: string;
  filters: Readonly<Record<string, unknown>>;
}

export interface CursorCandidate {
  id: string;
  revision: number;
  updatedAt: string;
}

export interface CursorEntry extends CursorCandidate {
  ordinal: number;
}

export interface CursorSnapshot {
  id: string;
  start: number;
  expiresAt: string;
  state: InstallationAuthorizationState;
}

export async function createCursorSnapshot(
  db: D1DatabaseLike,
  authority: WorkshopAuthorizationAuthority,
  codec: WorkshopCursorCodec,
  binding: CursorBinding,
  context: AuthorizationContext,
  candidates: readonly CursorCandidate[],
  pageSize: number,
  now = new Date(),
): Promise<CursorSnapshot> {
  if (candidates.length === 0 || candidates.length > MAX_SNAPSHOT_ENTRIES)
    throw boundedQuery();
  const state = await requireCurrentAuthorizationState(authority, context);
  const id = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString();
  const digests = await bindingDigests(codec, binding, context);
  const entries = candidates.map((candidate, ordinal) => ({
    ordinal,
    recordId: candidate.id,
    recordRevision: candidate.revision,
    updatedAt: candidate.updatedAt,
  }));
  const statements = [
    db
      .prepare(
        `DELETE FROM workshop_cursor_snapshots WHERE id IN (
           SELECT id FROM workshop_cursor_snapshots
           WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(issuedAt, CLEANUP_BATCH),
    db
      .prepare(
        `INSERT INTO workshop_cursor_snapshots
         (id, installation_id, principal_id, grant_digest,
          authorization_revision, search_generation, domain, operation,
          query_digest, filters_digest, page_size, entry_count, issued_at,
          expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        context.installationId,
        context.principalId,
        digests.grant,
        state.authorizationRevision,
        state.searchGeneration,
        binding.domain,
        binding.operation,
        digests.query,
        digests.filters,
        pageSize,
        entries.length,
        issuedAt,
        expiresAt,
      ),
    db
      .prepare(
        `INSERT INTO workshop_cursor_entries
         (snapshot_id, ordinal, record_id, record_revision, updated_at)
         SELECT ?,
                CAST(json_extract(value, '$.ordinal') AS INTEGER),
                json_extract(value, '$.recordId'),
                CAST(json_extract(value, '$.recordRevision') AS INTEGER),
                json_extract(value, '$.updatedAt')
         FROM json_each(?)`,
      )
      .bind(id, JSON.stringify(entries)),
  ];
  await authority.commitCursorSnapshot(db, context, state, statements);
  return { id, start: 0, expiresAt, state };
}

export async function openCursorSnapshot(
  db: D1DatabaseLike,
  authority: WorkshopAuthorizationAuthority,
  codec: WorkshopCursorCodec,
  token: string,
  binding: CursorBinding,
  context: AuthorizationContext,
  now = new Date(),
): Promise<CursorSnapshot> {
  try {
    if (!token || token.length > MAX_CURSOR_LENGTH) throw new Error('invalid');
    const generation = generationValue(await codec.currentGeneration());
    const bytes = await codec.open(generation, token);
    if (!(bytes instanceof Uint8Array)) throw new Error('invalid');
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!isRecord(value)) throw new Error('invalid');
    exactKeys(value, [
      'version',
      'generation',
      'snapshotId',
      'start',
      'expiresAt',
    ]);
    if (
      value.version !== 2 ||
      value.generation !== generation ||
      typeof value.snapshotId !== 'string' ||
      !value.snapshotId ||
      !Number.isSafeInteger(value.start) ||
      (value.start as number) < 0 ||
      typeof value.expiresAt !== 'string' ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt ||
      value.expiresAt <= now.toISOString()
    )
      throw new Error('invalid');
    const state = await requireCurrentAuthorizationState(authority, context);
    const snapshot = await db
      .prepare(
        `SELECT installation_id, principal_id, grant_digest,
                authorization_revision, search_generation, domain, operation,
                query_digest, filters_digest, page_size, entry_count,
                expires_at
         FROM workshop_cursor_snapshots WHERE id = ?`,
      )
      .bind(value.snapshotId)
      .first<SnapshotRow>();
    if (!snapshot || snapshot.expires_at !== value.expiresAt)
      throw new Error('invalid');
    const digests = await bindingDigests(codec, binding, context);
    if (
      snapshot.installation_id !== context.installationId ||
      snapshot.principal_id !== context.principalId ||
      snapshot.grant_digest !== digests.grant ||
      snapshot.authorization_revision !== state.authorizationRevision ||
      snapshot.search_generation !== state.searchGeneration ||
      snapshot.domain !== binding.domain ||
      snapshot.operation !== binding.operation ||
      snapshot.query_digest !== digests.query ||
      snapshot.filters_digest !== digests.filters ||
      snapshot.expires_at <= now.toISOString() ||
      (value.start as number) >= snapshot.entry_count
    )
      throw new Error('invalid');
    return {
      id: value.snapshotId,
      start: value.start as number,
      expiresAt: value.expiresAt,
      state,
    };
  } catch {
    throw invalidCursor();
  }
}

export async function readCursorEntries(
  db: D1DatabaseLike,
  snapshot: CursorSnapshot,
  limit: number,
): Promise<CursorEntry[]> {
  const result = await db
    .prepare(
      `SELECT ordinal, record_id, record_revision, updated_at
       FROM workshop_cursor_entries
       WHERE snapshot_id = ? AND ordinal >= ?
       ORDER BY ordinal LIMIT ?`,
    )
    .bind(snapshot.id, snapshot.start, limit + 1)
    .all<EntryRow>();
  return result.results.map((row) => ({
    ordinal: row.ordinal,
    id: row.record_id,
    revision: row.record_revision,
    updatedAt: row.updated_at,
  }));
}

export async function encodeCursor(
  codec: WorkshopCursorCodec,
  snapshot: CursorSnapshot,
  start: number,
): Promise<string> {
  try {
    const generation = generationValue(await codec.currentGeneration());
    const token = await codec.seal(
      generation,
      encoder.encode(
        JSON.stringify({
          version: 2,
          generation,
          snapshotId: snapshot.id,
          start,
          expiresAt: snapshot.expiresAt,
        }),
      ),
    );
    if (!token || token.length > MAX_CURSOR_LENGTH) throw new Error('invalid');
    return token;
  } catch {
    throw new WorkshopError('internal_error', 'Pagination cursor unavailable');
  }
}

export async function requireUnchangedCursorState(
  authority: WorkshopAuthorizationAuthority,
  context: AuthorizationContext,
  expected: InstallationAuthorizationState,
): Promise<void> {
  const actual = await requireCurrentAuthorizationState(authority, context);
  if (
    actual.installationId !== expected.installationId ||
    actual.authorizationRevision !== expected.authorizationRevision ||
    actual.searchGeneration !== expected.searchGeneration
  )
    throw denied();
}

export function assertCursorCandidatesBounded(count: number): void {
  if (count > MAX_SNAPSHOT_ENTRIES) throw boundedQuery();
}

function boundedQuery(): WorkshopError {
  return new WorkshopError(
    'limit_exceeded',
    'Query exceeds the bounded pagination snapshot limit',
    413,
  );
}

async function bindingDigests(
  codec: WorkshopCursorCodec,
  binding: CursorBinding,
  context: AuthorizationContext,
): Promise<{ grant: string; query: string; filters: string }> {
  const digest = async (purpose: string, value: string) => {
    const result = await codec.digest(
      `workshop.cursor.v2.${purpose}`,
      encoder.encode(value),
    );
    if (typeof result !== 'string' || !result || result.length > 512)
      throw new Error('invalid digest');
    return result;
  };
  return {
    grant: await digest('grant', authorizationCursorKey(context)),
    query: await digest('query', binding.query),
    filters: await digest('filters', JSON.stringify(binding.filters)),
  };
}

function generationValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('invalid');
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error('invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidCursor(): WorkshopError {
  return new WorkshopError(
    'validation_failed',
    'Invalid pagination cursor',
    400,
    { field: 'cursor' },
  );
}

interface SnapshotRow {
  installation_id: string;
  principal_id: string;
  grant_digest: string;
  authorization_revision: number;
  search_generation: number;
  domain: 'task' | 'memory' | 'prompt';
  operation: string;
  query_digest: string;
  filters_digest: string;
  page_size: number;
  entry_count: number;
  expires_at: string;
}

interface EntryRow {
  ordinal: number;
  record_id: string;
  record_revision: number;
  updated_at: string;
}
