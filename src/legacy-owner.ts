import {
  assertWorkshopLegacyV042Schema,
  type WorkshopReadOnlyPersistence,
} from './migrations.js';
import { workshopMigrations } from './migrations/manifest.js';
import { WorkshopError } from './protocol/errors.js';
import type { D1DatabaseLike } from './server/database.js';

const LEGACY_TABLES = [
  'workshop_cursor_entries',
  'workshop_cursor_snapshots',
  'workshop_memories',
  'workshop_memory_revisions',
  'workshop_onboarding_runs',
  'workshop_onboarding_steps',
  'workshop_prompt_revisions',
  'workshop_prompts',
  'workshop_schema',
  'workshop_task_revisions',
  'workshop_tasks',
] as const;

const LEGACY_IMPORT_ORDER: readonly Exclude<
  LegacyTableName,
  'workshop_schema'
>[] = [
  'workshop_onboarding_runs',
  'workshop_onboarding_steps',
  'workshop_tasks',
  'workshop_task_revisions',
  'workshop_memories',
  'workshop_memory_revisions',
  'workshop_prompts',
  'workshop_prompt_revisions',
  'workshop_cursor_snapshots',
  'workshop_cursor_entries',
];

const DEFAULT_MAX_ROWS = 50_000;
const MAX_MAX_ROWS = 100_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_MAX_BYTES = 32 * 1024 * 1024;

type LegacyTableName = (typeof LEGACY_TABLES)[number];
type LegacyScalar = string | number | null;
type LegacyRow = Readonly<Record<string, LegacyScalar>>;

interface LegacyOwnerPayload {
  tables: Readonly<Record<LegacyTableName, readonly LegacyRow[]>>;
}

declare const legacyOwnerFragmentBrand: unique symbol;

/**
 * Process-local, verified owner fragment. Its row representation is intentionally
 * absent from the public declarations and can only be consumed by the adoption
 * adapter below.
 */
export interface WorkshopLegacyOwnerFragmentV042 {
  readonly [legacyOwnerFragmentBrand]: 'WorkshopLegacyOwnerFragmentV042';
}

export interface WorkshopLegacyV042LedgerEvidence {
  namespace: '@gnolith/workshop';
  migrations: readonly {
    id: string;
    checksum: `sha256:${string}`;
  }[];
}

export interface WorkshopLegacyV042Attestation {
  packageName: '@gnolith/workshop';
  packageVersion: '0.4.2';
  schemaVersion: 6;
  migrationLedger: WorkshopLegacyV042LedgerEvidence;
}

export interface WorkshopLegacyV042DecodeOptions {
  maxRows?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface WorkshopLegacyOwnerDecodedV042 {
  format: 'gnolith-workshop-legacy-owner-v042';
  version: 1;
  source: {
    packageName: '@gnolith/workshop';
    packageVersion: '0.4.2';
    schemaVersion: 6;
  };
  counts: {
    tasks: number;
    memories: number;
    prompts: number;
    revisions: number;
  };
  tableCounts: Readonly<Record<LegacyTableName, number>>;
  digests: {
    tables: Readonly<Record<LegacyTableName, `sha256:${string}`>>;
    migrationLedger: `sha256:${string}`;
    ownerFragment: `sha256:${string}`;
  };
  migrationLedger: WorkshopLegacyV042LedgerEvidence;
  ownerFragment: WorkshopLegacyOwnerFragmentV042;
}

export interface WorkshopLegacyOwnerAdoptionHandle {
  readonly owner: '@gnolith/workshop';
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  adoptLegacyOwnerV042(input: {
    installationId: string;
    fragment: WorkshopLegacyOwnerFragmentV042;
    sourceDigest: `sha256:${string}`;
    migrationLedger: WorkshopLegacyV042LedgerEvidence;
    expireClaimsAt: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkshopLegacyOwnerDestinationBindingV1 {
  connectionId: string;
  registrationFingerprint: string;
}

/**
 * Creates the owner-scoped exact-0.4.2 adoption handle. The factory retains all
 * Workshop table knowledge; assembly code receives only the sealed handle.
 */
export function createWorkshopLegacyOwnerAdoptionHandleV1(
  db: D1DatabaseLike,
  binding: WorkshopLegacyOwnerDestinationBindingV1,
): WorkshopLegacyOwnerAdoptionHandle {
  validateDestinationBinding(binding);
  return Object.freeze({
    owner: '@gnolith/workshop' as const,
    connectionId: binding.connectionId,
    registrationFingerprint: binding.registrationFingerprint,
    async adoptLegacyOwnerV042(
      input: Parameters<
        WorkshopLegacyOwnerAdoptionHandle['adoptLegacyOwnerV042']
      >[0],
    ) {
      input.signal.throwIfAborted();
      const payload = fragmentPayloads.get(input.fragment);
      if (!payload) throw invalid('Legacy owner fragment is not verified');
      if ((await digest(canonicalJson(payload))) !== input.sourceDigest)
        throw invalid('Legacy owner fragment digest does not match');
      validateAttestation({
        packageName: '@gnolith/workshop',
        packageVersion: '0.4.2',
        schemaVersion: 6,
        migrationLedger: input.migrationLedger,
      });
      validateIdentifier(input.installationId);
      if (!Number.isFinite(Date.parse(input.expireClaimsAt)))
        throw invalid('Legacy claim expiry is invalid');

      const statements: ReturnType<D1DatabaseLike['prepare']>[] = [];
      for (const table of LEGACY_IMPORT_ORDER) {
        for (const row of payload.tables[table]) {
          input.signal.throwIfAborted();
          const rebound = rebindInstallation(row, input.installationId);
          const columns = Object.keys(rebound);
          statements.push(
            db
              .prepare(
                `INSERT INTO "${table}" (${columns
                  .map((column) => `"${column}"`)
                  .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              )
              .bind(...columns.map((column) => rebound[column])),
          );
        }
      }
      // Legacy boolean claims have no v7 lease token and must never become an
      // unowned live lease in the destination.
      statements.push(
        db
          .prepare(
            `UPDATE workshop_tasks
             SET claimed = 0, claimed_at = NULL
             WHERE installation_id = ? AND claimed != 0`,
          )
          .bind(input.installationId),
      );
      await db.batch(statements);
    },
  });
}

export interface WorkshopLegacyOwnerAdoptionReceiptV1 {
  format: 'gnolith-workshop-legacy-owner-adoption-v1';
  version: 1;
  installationId: string;
  sourceDigest: `sha256:${string}`;
  adoptedAt: string;
  counts: WorkshopLegacyOwnerDecodedV042['counts'];
}

const fragmentPayloads = new WeakMap<object, LegacyOwnerPayload>();
const verifiedDecodes = new WeakSet<object>();

/**
 * Decode exact Workshop 0.4.2 state through a read-only portable DB capability.
 * Only the fixed Workshop-owned allowlist above is inspected.
 */
export async function decodeWorkshopLegacyOwnerV042(
  source: WorkshopReadOnlyPersistence,
  attestation: WorkshopLegacyV042Attestation,
  options: WorkshopLegacyV042DecodeOptions = {},
): Promise<WorkshopLegacyOwnerDecodedV042> {
  validateAttestation(attestation);
  const maxRows = boundedOption(
    options.maxRows,
    DEFAULT_MAX_ROWS,
    MAX_MAX_ROWS,
    'row',
  );
  const maxBytes = boundedOption(
    options.maxBytes,
    DEFAULT_MAX_BYTES,
    MAX_MAX_BYTES,
    'byte',
  );
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  await assertWorkshopLegacyV042Schema(source);

  const tableCounts = {} as Record<LegacyTableName, number>;
  let totalRows = 0;
  for (const table of LEGACY_TABLES) {
    signal.throwIfAborted();
    const result = await source
      .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
      .first<{ count: number }>();
    const count = result?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw invalid(`Legacy row count for ${table} is invalid`);
    tableCounts[table] = count;
    totalRows += count;
    if (totalRows > maxRows)
      throw invalid(`Legacy owner fragment exceeds ${maxRows} rows`);
  }

  const tables = {} as Record<LegacyTableName, readonly LegacyRow[]>;
  const tableDigests = {} as Record<LegacyTableName, `sha256:${string}`>;
  let encodedBytes = 0;
  for (const table of LEGACY_TABLES) {
    signal.throwIfAborted();
    const result = await source
      .prepare(`SELECT * FROM "${table}" LIMIT ?`)
      .bind(tableCounts[table] + 1)
      .all<Record<string, unknown>>();
    if (result.results.length !== tableCounts[table])
      throw invalid(`Legacy source changed while reading ${table}`);
    const rows = result.results
      .map((row) => normalizeRow(table, row))
      .sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      );
    const encoded = canonicalJson(rows);
    encodedBytes += new TextEncoder().encode(encoded).byteLength;
    if (encodedBytes > maxBytes)
      throw invalid(`Legacy owner fragment exceeds ${maxBytes} bytes`);
    tables[table] = Object.freeze(rows);
    tableDigests[table] = await digest(encoded);
  }

  const migrationLedger = freezeLedger(attestation.migrationLedger);
  const counts = Object.freeze({
    tasks: tableCounts.workshop_tasks,
    memories: tableCounts.workshop_memories,
    prompts: tableCounts.workshop_prompts,
    revisions:
      tableCounts.workshop_task_revisions +
      tableCounts.workshop_memory_revisions +
      tableCounts.workshop_prompt_revisions,
  });
  const payload = Object.freeze({
    tables: Object.freeze(tables),
  }) satisfies LegacyOwnerPayload;
  const fragment = Object.freeze({}) as WorkshopLegacyOwnerFragmentV042;
  fragmentPayloads.set(fragment, payload);
  const ownerFragmentDigest = await digest(canonicalJson(payload));
  const decoded = Object.freeze({
    format: 'gnolith-workshop-legacy-owner-v042' as const,
    version: 1 as const,
    source: Object.freeze({
      packageName: '@gnolith/workshop' as const,
      packageVersion: '0.4.2' as const,
      schemaVersion: 6 as const,
    }),
    counts,
    tableCounts: Object.freeze(tableCounts),
    digests: Object.freeze({
      tables: Object.freeze(tableDigests),
      migrationLedger: await digest(canonicalJson(migrationLedger)),
      ownerFragment: ownerFragmentDigest,
    }),
    migrationLedger,
    ownerFragment: fragment,
  });
  verifiedDecodes.add(decoded);
  return decoded;
}

/**
 * Adopt a verified fragment through Workshop's owner-scoped destination handle.
 * The decoder never mutates the legacy source and this adapter exposes no CLI.
 */
export async function adoptWorkshopLegacyOwnerV042(
  decoded: WorkshopLegacyOwnerDecodedV042,
  destination: WorkshopLegacyOwnerAdoptionHandle,
  installationId: string,
  options: { clock?: () => Date; signal?: AbortSignal } = {},
): Promise<WorkshopLegacyOwnerAdoptionReceiptV1> {
  if (
    !verifiedDecodes.has(decoded) ||
    !fragmentPayloads.has(decoded.ownerFragment)
  )
    throw invalid('Legacy owner decode is not verified');
  if (
    destination.owner !== '@gnolith/workshop' ||
    !validBindingValue(destination.connectionId) ||
    !/^[a-f0-9]{64}$/u.test(destination.registrationFingerprint)
  )
    throw invalid('Legacy owner destination binding is invalid');
  validateIdentifier(installationId);
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const adoptedAt = (options.clock ?? (() => new Date()))().toISOString();
  await destination.adoptLegacyOwnerV042({
    installationId,
    fragment: decoded.ownerFragment,
    sourceDigest: decoded.digests.ownerFragment,
    migrationLedger: decoded.migrationLedger,
    expireClaimsAt: adoptedAt,
    signal,
  });
  return {
    format: 'gnolith-workshop-legacy-owner-adoption-v1',
    version: 1,
    installationId,
    sourceDigest: decoded.digests.ownerFragment,
    adoptedAt,
    counts: decoded.counts,
  };
}

function validateAttestation(attestation: WorkshopLegacyV042Attestation): void {
  if (!isRecord(attestation))
    throw invalid('Legacy attestation must be an object');
  exactKeys(attestation, [
    'packageName',
    'packageVersion',
    'schemaVersion',
    'migrationLedger',
  ]);
  if (
    attestation.packageName !== '@gnolith/workshop' ||
    attestation.packageVersion !== '0.4.2' ||
    attestation.schemaVersion !== 6
  )
    throw invalid('Legacy source must attest exact Workshop 0.4.2');
  if (
    !isRecord(attestation.migrationLedger) ||
    !Array.isArray(attestation.migrationLedger.migrations)
  )
    throw invalid('Legacy migration-ledger evidence is incompatible');
  exactKeys(attestation.migrationLedger, ['namespace', 'migrations']);
  const expected = workshopMigrations.slice(0, 6);
  if (
    attestation.migrationLedger.namespace !== '@gnolith/workshop' ||
    attestation.migrationLedger.migrations.length !== expected.length
  )
    throw invalid('Legacy migration-ledger evidence is incompatible');
  const migrations = attestation.migrationLedger
    .migrations as readonly unknown[];
  for (let index = 0; index < expected.length; index += 1) {
    const actual = migrations[index];
    const migration = expected[index]!;
    if (!isRecord(actual))
      throw invalid('Legacy migration-ledger evidence is incompatible');
    exactKeys(actual, ['id', 'checksum']);
    if (actual.id !== migration.id || actual.checksum !== migration.checksum)
      throw invalid('Legacy migration-ledger evidence is incompatible');
  }
}

function freezeLedger(
  value: WorkshopLegacyV042LedgerEvidence,
): WorkshopLegacyV042LedgerEvidence {
  return Object.freeze({
    namespace: '@gnolith/workshop',
    migrations: Object.freeze(
      value.migrations.map(({ id, checksum }) =>
        Object.freeze({ id, checksum }),
      ),
    ),
  });
}

function normalizeRow(
  table: LegacyTableName,
  value: Record<string, unknown>,
): LegacyRow {
  const normalized: Record<string, LegacyScalar> = {};
  for (const [key, field] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      field !== null &&
      typeof field !== 'string' &&
      (typeof field !== 'number' || !Number.isSafeInteger(field))
    )
      throw invalid(`Legacy ${table} contains a non-portable value`);
    normalized[key] = field;
  }
  return Object.freeze(normalized);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

async function digest(value: string): Promise<`sha256:${string}`> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw invalid(`Legacy ${label} bound is invalid`);
  return result;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw invalid('Legacy attestation has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw invalid('Legacy adoption installation identifier is invalid');
}

function validBindingValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateDestinationBinding(
  binding: WorkshopLegacyOwnerDestinationBindingV1,
): void {
  if (
    !validBindingValue(binding.connectionId) ||
    !/^[a-f0-9]{64}$/u.test(binding.registrationFingerprint)
  )
    throw invalid('Legacy owner destination binding is invalid');
}

function rebindInstallation(
  row: LegacyRow,
  installationId: string,
): Record<string, LegacyScalar> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'installation_id' ? installationId : value,
    ]),
  );
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
