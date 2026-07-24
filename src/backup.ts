import { WorkshopError } from './protocol/errors.js';

export * from './legacy-owner.js';

export interface WorkshopBackupDocumentV1 {
  format: 'gnolith-workshop-backup-v1';
  version: 1;
  createdAt: string;
  installationId: string;
  schemaVersion: number;
  sections: {
    workshop: unknown;
    migrationLedgerSlice: unknown;
  };
}

export interface WorkshopBackupInspection {
  valid: boolean;
  format: 'gnolith-workshop-backup-v1';
  version: 1;
  installationId: string;
  schemaVersion: number;
  legacy: {
    taskCount: number;
    memoryCount: number;
    promptCount: number;
    onboarding: {
      retained: number;
      migrated: number;
      deferred: number;
    };
  };
}

export interface WorkshopBackupOwnerHandle {
  readonly owner: '@gnolith/workshop';
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  exportOwnedState(input: {
    installationId: string;
    signal: AbortSignal;
  }): Promise<unknown>;
  inspectOwnedState(input: { state: unknown; signal: AbortSignal }): Promise<{
    taskCount: number;
    memoryCount: number;
    promptCount: number;
    onboarding: {
      retained: number;
      migrated: number;
      deferred: number;
    };
  }>;
  importOwnedState(input: {
    installationId: string;
    state: unknown;
    expireTaskLeasesAt: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkshopMigrationLedgerBackupHandle {
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  exportOwnedSlice(input: { signal: AbortSignal }): Promise<unknown>;
  inspectOwnedSlice(input: {
    state: unknown;
    signal: AbortSignal;
  }): Promise<void>;
  importOwnedSlice(input: {
    state: unknown;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WorkshopBackupDependencies {
  owner: WorkshopBackupOwnerHandle;
  ledger: WorkshopMigrationLedgerBackupHandle;
  schemaVersion: number;
  clock?: () => Date;
}

export function createWorkshopBackupApi(
  dependencies: WorkshopBackupDependencies,
) {
  validateBinding(dependencies);
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async exportBackup(
      installationId: string,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupDocumentV1> {
      validateIdentifier(installationId);
      const [workshop, migrationLedgerSlice] = await Promise.all([
        dependencies.owner.exportOwnedState({ installationId, signal }),
        dependencies.ledger.exportOwnedSlice({ signal }),
      ]);
      return {
        format: 'gnolith-workshop-backup-v1',
        version: 1,
        createdAt: clock().toISOString(),
        installationId,
        schemaVersion: dependencies.schemaVersion,
        sections: { workshop, migrationLedgerSlice },
      };
    },
    async inspectBackup(
      value: unknown,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupInspection> {
      const backup = validateBackup(value, dependencies.schemaVersion);
      const legacy = await dependencies.owner.inspectOwnedState({
        state: backup.sections.workshop,
        signal,
      });
      await dependencies.ledger.inspectOwnedSlice({
        state: backup.sections.migrationLedgerSlice,
        signal,
      });
      validateCounts(legacy);
      return {
        valid: true,
        format: backup.format,
        version: backup.version,
        installationId: backup.installationId,
        schemaVersion: backup.schemaVersion,
        legacy,
      };
    },
    async importBackup(
      value: unknown,
      signal = new AbortController().signal,
    ): Promise<WorkshopBackupInspection> {
      const inspected = await this.inspectBackup(value, signal);
      const backup = value as WorkshopBackupDocumentV1;
      await dependencies.owner.importOwnedState({
        installationId: backup.installationId,
        state: backup.sections.workshop,
        expireTaskLeasesAt: clock().toISOString(),
        signal,
      });
      await dependencies.ledger.importOwnedSlice({
        state: backup.sections.migrationLedgerSlice,
        signal,
      });
      return inspected;
    },
  };
}

function validateBinding(dependencies: WorkshopBackupDependencies): void {
  if (
    dependencies.owner.owner !== '@gnolith/workshop' ||
    !dependencies.owner.connectionId ||
    dependencies.owner.connectionId !== dependencies.ledger.connectionId ||
    !dependencies.owner.registrationFingerprint ||
    dependencies.owner.registrationFingerprint !==
      dependencies.ledger.registrationFingerprint ||
    !Number.isSafeInteger(dependencies.schemaVersion) ||
    dependencies.schemaVersion < 1
  )
    throw invalid('Backup owner binding is invalid');
}

function validateBackup(
  value: unknown,
  schemaVersion: number,
): WorkshopBackupDocumentV1 {
  if (!isRecord(value)) throw invalid('Backup document must be an object');
  exactKeys(value, [
    'format',
    'version',
    'createdAt',
    'installationId',
    'schemaVersion',
    'sections',
  ]);
  if (
    value.format !== 'gnolith-workshop-backup-v1' ||
    value.version !== 1 ||
    value.schemaVersion !== schemaVersion ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.sections)
  )
    throw invalid('Backup document is incompatible');
  validateIdentifier(value.installationId);
  exactKeys(value.sections, ['workshop', 'migrationLedgerSlice']);
  return value as unknown as WorkshopBackupDocumentV1;
}

function validateCounts(value: {
  taskCount: number;
  memoryCount: number;
  promptCount: number;
  onboarding: {
    retained: number;
    migrated: number;
    deferred: number;
  };
}): void {
  for (const count of [
    value.taskCount,
    value.memoryCount,
    value.promptCount,
    value.onboarding.retained,
    value.onboarding.migrated,
    value.onboarding.deferred,
  ])
    if (!Number.isSafeInteger(count) || count < 0)
      throw invalid('Backup inspection counts are invalid');
}

function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw invalid('Backup installation identifier is invalid');
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    throw invalid('Backup document has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
export * from './resource-blobs.js';
