import { WorkshopError } from '../protocol/errors.js';
import type {
  AuthorizationContext as ProtocolAuthorizationContext,
  VisibilityAtomV1,
  VisibilityScopeV1,
  WorkshopCapability,
  WorkshopPrincipal,
} from '../protocol.js';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from './database.js';

export const SEARCH_ADMIN_CAPABILITY = 'search:admin' as const;

export type AuthorizationContext = ProtocolAuthorizationContext;
export type { VisibilityAtomV1, VisibilityScopeV1 };

export interface InstallationAuthorizationState {
  installationId: string;
  authorizationRevision: number;
  searchGeneration: number;
}

/** Must return live state, never a request-local cached value. */
export interface WorkshopAuthorizationSource {
  getInstallationAuthorizationState(): Promise<InstallationAuthorizationState | null>;
}

/**
 * Host-owned atomic authorization fences. Task and Memory use separately
 * issued guards bound to their exact domain capability. Each method must assert
 * this exact context against the shared persisted authority and execute the
 * mutation in the same database transaction or atomic batch. Host adapters
 * must translate a Taproot authorization rejection to Workshop `forbidden`,
 * while leaving unrelated database/infrastructure failures as internal errors.
 */
export interface WorkshopAuthorizationAuthority extends WorkshopAuthorizationSource {
  commitTaskMutation<T>(
    db: D1DatabaseLike,
    context: AuthorizationContext,
    mutation: D1PreparedStatementLike,
  ): Promise<T | null>;
  commitMemoryMutation<T>(
    db: D1DatabaseLike,
    context: AuthorizationContext,
    mutation: D1PreparedStatementLike,
  ): Promise<T | null>;
  commitTaskBackfill(
    db: D1DatabaseLike,
    context: AuthorizationContext,
    expectedState: InstallationAuthorizationState,
    mutations: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
  commitMemoryBackfill(
    db: D1DatabaseLike,
    context: AuthorizationContext,
    expectedState: InstallationAuthorizationState,
    mutations: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
  commitCursorSnapshot(
    db: D1DatabaseLike,
    context: AuthorizationContext,
    expectedState: InstallationAuthorizationState,
    mutations: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
}

/** Durable source suitable for D1 and native SQLite hosts. */
export interface AuthorizedRecord {
  installationId: string;
  authorizationRevision: number;
  visibility: VisibilityScopeV1;
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CLAUSES = 64;
const MAX_ATOMS_PER_CLAUSE = 64;

export function authorize(
  principal: WorkshopPrincipal | null,
  capability: WorkshopCapability,
): AuthorizationContext {
  if (!principal) {
    throw new WorkshopError('unauthenticated', 'Authentication is required');
  }
  const context = normalizeAuthorizationContext(principal);
  if (!context.capabilities.includes(capability)) {
    throw denied();
  }
  return context;
}

/** Administrative capabilities are exact and never imply one another. */
export function requireSearchAdministration(
  context: AuthorizationContext,
): void {
  if (
    !normalizeAuthorizationContext(context).capabilities.includes(
      SEARCH_ADMIN_CAPABILITY,
    )
  )
    throw denied();
}

export function normalizeAuthorizationContext(
  value: AuthorizationContext,
): AuthorizationContext {
  if (!isRecord(value)) invalid('authorization context must be an object');
  exactKeys(value, [
    'installationId',
    'principalId',
    'activeWorkspaceId',
    'workspaceIds',
    'capabilities',
    'authorizationRevision',
  ]);
  const installationId = identifier(value.installationId, 'installationId');
  const principalId = identifier(value.principalId, 'principalId');
  const activeWorkspaceId =
    value.activeWorkspaceId === null
      ? null
      : identifier(value.activeWorkspaceId, 'activeWorkspaceId');
  const workspaceIds = stringSet(value.workspaceIds, 'workspaceIds');
  const capabilities = stringSet(
    value.capabilities,
    'capabilities',
  ) as WorkshopCapability[];
  const authorizationRevision = revision(
    value.authorizationRevision,
    'authorizationRevision',
  );
  if (activeWorkspaceId !== null && !workspaceIds.includes(activeWorkspaceId))
    invalid('activeWorkspaceId must be present in workspaceIds');
  return {
    installationId,
    principalId,
    activeWorkspaceId,
    workspaceIds,
    capabilities,
    authorizationRevision,
  };
}

export function normalizeVisibilityScope(
  value: VisibilityScopeV1,
): VisibilityScopeV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.clauses))
    invalid('visibility scope must be a version 1 CNF object');
  exactKeys(value, ['version', 'clauses']);
  if (value.clauses.length > MAX_CLAUSES)
    invalid(`visibility scope exceeds ${MAX_CLAUSES} clauses`);
  const clauses = new Map<string, VisibilityAtomV1[]>();
  for (const rawClause of value.clauses) {
    if (!Array.isArray(rawClause) || rawClause.length === 0)
      invalid('visibility clauses must contain at least one atom');
    if (rawClause.length > MAX_ATOMS_PER_CLAUSE)
      invalid(`visibility clause exceeds ${MAX_ATOMS_PER_CLAUSE} atoms`);
    const atoms = new Map<string, VisibilityAtomV1>();
    let publicClause = false;
    for (const rawAtom of rawClause) {
      const atom = normalizeAtom(rawAtom);
      if (atom.kind === 'public') {
        publicClause = true;
        break;
      }
      atoms.set(JSON.stringify(atom), atom);
    }
    if (publicClause) continue;
    const sorted = [...atoms.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, atom]) => atom);
    if (sorted.length === 0)
      invalid('visibility clause is empty after normalization');
    clauses.set(JSON.stringify(sorted), sorted);
  }
  return {
    version: 1,
    clauses: [...clauses.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, clause]) => clause),
  };
}

export function serializeVisibilityScope(scope: VisibilityScopeV1): string {
  return JSON.stringify(normalizeVisibilityScope(scope));
}

export function ownerVisibility(principalId: string): VisibilityScopeV1 {
  return normalizeVisibilityScope({
    version: 1,
    clauses: [[{ kind: 'principal', principalId }]],
  });
}

export function defaultVisibility(
  context: AuthorizationContext,
): VisibilityScopeV1 {
  const workspaceId = requireActiveWorkspace(context);
  return normalizeVisibilityScope({
    version: 1,
    clauses: [[{ kind: 'workspace', workspaceId }]],
  });
}

export function requireCapability(
  context: AuthorizationContext,
  capability: WorkshopCapability,
): void {
  const normalized = normalizeAuthorizationContext(context);
  if (!normalized.capabilities.includes(capability)) throw denied();
}

export function isVisibleTo(
  rawScope: VisibilityScopeV1,
  rawContext: AuthorizationContext,
): boolean {
  const scope = normalizeVisibilityScope(rawScope);
  const context = normalizeAuthorizationContext(rawContext);
  const workspaces = new Set(context.workspaceIds);
  const capabilities = new Set<string>(context.capabilities);
  return scope.clauses.every((clause) =>
    clause.some((atom) => {
      switch (atom.kind) {
        case 'public':
          return true;
        case 'principal':
          return atom.principalId === context.principalId;
        case 'workspace':
          return workspaces.has(atom.workspaceId);
        case 'capability':
          return capabilities.has(atom.capability);
      }
    }),
  );
}

export async function requireCurrentAuthorization(
  source: WorkshopAuthorizationSource,
  rawContext: AuthorizationContext,
): Promise<AuthorizationContext> {
  await requireCurrentAuthorizationState(source, rawContext);
  return normalizeAuthorizationContext(rawContext);
}

export async function requireCurrentAuthorizationState(
  source: WorkshopAuthorizationSource,
  rawContext: AuthorizationContext,
): Promise<InstallationAuthorizationState> {
  const context = normalizeAuthorizationContext(rawContext);
  let state: InstallationAuthorizationState | null;
  try {
    state = await source.getInstallationAuthorizationState();
  } catch {
    throw denied();
  }
  if (
    !state ||
    state.installationId !== context.installationId ||
    state.authorizationRevision !== context.authorizationRevision ||
    !Number.isSafeInteger(state.searchGeneration) ||
    state.searchGeneration < 0
  )
    throw denied();
  return state;
}

export function requireActiveWorkspace(context: AuthorizationContext): string {
  if (context.activeWorkspaceId === null) throw denied();
  return context.activeWorkspaceId;
}

export function authorizeRecord(
  record: AuthorizedRecord,
  context: AuthorizationContext,
): void {
  if (
    record.installationId !== context.installationId ||
    record.authorizationRevision > context.authorizationRevision ||
    !isVisibleTo(record.visibility, context)
  )
    throw denied();
}

/** SQL predicate evaluated before any content column is selected. */
export function visibilitySql(
  alias: string,
  context: AuthorizationContext,
): { sql: string; values: unknown[] } {
  const normalized = normalizeAuthorizationContext(context);
  const sql = `${alias}.installation_id = ?
    AND ${alias}.owner_principal_id IS NOT NULL
    AND ${alias}.workspace_id IS NOT NULL
    AND ${alias}.visibility_scope IS NOT NULL
    AND json_valid(${alias}.visibility_scope)
    AND json_type(${alias}.visibility_scope) = 'object'
    AND json_extract(${alias}.visibility_scope, '$.version') = 1
    AND json_type(${alias}.visibility_scope, '$.clauses') = 'array'
    AND (SELECT COUNT(*) FROM json_each(${alias}.visibility_scope)) = 2
    AND (SELECT COUNT(*) FROM json_each(${alias}.visibility_scope, '$.clauses')) <= 64
    AND ${alias}.authorization_revision <= ? AND NOT EXISTS (
    SELECT 1 FROM json_each(${alias}.visibility_scope, '$.clauses') AS clause
    WHERE json_type(clause.value) != 'array'
       OR json_array_length(clause.value) = 0
       OR json_array_length(clause.value) > 64
       OR EXISTS (
         SELECT 1 FROM json_each(clause.value) AS malformed
         WHERE json_type(malformed.value) != 'object'
            OR json_extract(malformed.value, '$.kind') = 'public'
            OR json_extract(malformed.value, '$.kind') NOT IN ('principal', 'workspace', 'capability')
            OR (SELECT COUNT(*) FROM json_each(malformed.value)) != 2
       )
       OR NOT EXISTS (
      SELECT 1 FROM json_each(clause.value) AS atom
      WHERE (json_extract(atom.value, '$.kind') = 'principal' AND json_extract(atom.value, '$.principalId') = ?)
         OR (json_extract(atom.value, '$.kind') = 'workspace' AND json_extract(atom.value, '$.workspaceId') IN (SELECT value FROM json_each(?)))
         OR (json_extract(atom.value, '$.kind') = 'capability' AND json_extract(atom.value, '$.capability') IN (SELECT value FROM json_each(?)))
    )
  )`;
  return {
    sql,
    values: [
      normalized.installationId,
      normalized.authorizationRevision,
      normalized.principalId,
      JSON.stringify(normalized.workspaceIds),
      JSON.stringify(normalized.capabilities),
    ],
  };
}

export function authorizationCursorKey(context: AuthorizationContext): string {
  return JSON.stringify(normalizeAuthorizationContext(context));
}

export function denied(): WorkshopError {
  return new WorkshopError('forbidden', 'Authorization denied');
}

function normalizeAtom(value: unknown): VisibilityAtomV1 {
  if (!isRecord(value) || typeof value.kind !== 'string')
    invalid('visibility atom must be an object');
  switch (value.kind) {
    case 'public':
      exactKeys(value, ['kind']);
      return { kind: 'public' };
    case 'principal':
      exactKeys(value, ['kind', 'principalId']);
      return {
        kind: 'principal',
        principalId: identifier(value.principalId, 'principalId'),
      };
    case 'workspace':
      exactKeys(value, ['kind', 'workspaceId']);
      return {
        kind: 'workspace',
        workspaceId: identifier(value.workspaceId, 'workspaceId'),
      };
    case 'capability':
      exactKeys(value, ['kind', 'capability']);
      return {
        kind: 'capability',
        capability: identifier(value.capability, 'capability'),
      };
    default:
      invalid('visibility atom kind is not supported');
  }
}

function stringSet(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256)
    invalid(`${field} must be an array with at most 256 entries`);
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${field} must be dense`);
    normalized.push(identifier(value[index], field));
  }
  return [...new Set(normalized)].sort(compareCodeUnits);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const normalized = value.normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    normalized.trim() !== normalized ||
    hasControlCharacter(normalized)
  )
    invalid(`${field} is invalid`);
  return normalized;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid(`${field} must be a non-negative safe integer`);
  return value as number;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    invalid('authorization value has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function invalid(message: string): never {
  throw new WorkshopError('validation_failed', message, 400);
}
