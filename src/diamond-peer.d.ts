declare module '@gnolith/diamond' {
  import type { WorkshopMigrationLedgerApi } from './migrations.js';

  export const ensureMigrationLedger: WorkshopMigrationLedgerApi['ensureMigrationLedger'];
  export const readAppliedMigrations: WorkshopMigrationLedgerApi['readAppliedMigrations'];
  export const applyNamespacedMigrations: WorkshopMigrationLedgerApi['applyNamespacedMigrations'];
  export const recordMigrationAdoption: WorkshopMigrationLedgerApi['recordMigrationAdoption'];
  export const checksumMigration: WorkshopMigrationLedgerApi['checksumMigration'];

  export interface MigrationLedgerSlice {
    readonly format: 'diamond-migration-ledger-slice-v1';
    readonly namespace: string;
    readonly entries: readonly {
      readonly id: string;
      readonly checksum: string;
      readonly appliedAt: string;
    }[];
    readonly canonicalSha256: string;
  }

  export interface MigrationLedgerOwnerHandle {
    readonly ownerRegistrationId: string;
    readonly namespace: string;
    readonly installationId: string;
    readonly connectionId: string;
  }

  export interface MigrationLedgerBackup {
    exportNamespace(
      owner: MigrationLedgerOwnerHandle,
    ): Promise<MigrationLedgerSlice>;
    validateNamespace(
      owner: MigrationLedgerOwnerHandle,
      slice: MigrationLedgerSlice,
    ): Promise<void>;
    restoreNamespace(
      owner: MigrationLedgerOwnerHandle,
      slice: MigrationLedgerSlice,
      options:
        { mode: 'empty' } | { mode: 'exact-adopt'; confirmExactSchema: true },
    ): Promise<void>;
  }

  export interface MigrationAssemblyAuthority {
    readonly format: 'diamond-migration-assembly-authority-v1';
  }

  export function createMigrationLedgerBackupV1(
    db: unknown,
    assemblyAuthority: MigrationAssemblyAuthority,
  ): MigrationLedgerBackup;

  export function registerMigrationLedgerOwnerV1(options: {
    db: unknown;
    installationId: string;
    namespace: string;
    migrations: readonly { id: string; statements: readonly string[] }[];
    assemblyAuthority: MigrationAssemblyAuthority;
  }): Promise<MigrationLedgerOwnerHandle>;

  export class D1QuadSource {
    constructor(db: unknown, options?: unknown);
    match(
      subject?: { termType?: string; value?: string } | null,
      predicate?: unknown,
      object?: unknown,
      graph?: unknown,
    ): {
      pipe(destination: unknown): unknown;
    };
  }
}
