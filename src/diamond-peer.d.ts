declare module '@gnolith/diamond' {
  import type { WorkshopMigrationLedgerApi } from './migrations.js';

  export const ensureMigrationLedger: WorkshopMigrationLedgerApi['ensureMigrationLedger'];
  export const readAppliedMigrations: WorkshopMigrationLedgerApi['readAppliedMigrations'];
  export const applyNamespacedMigrations: WorkshopMigrationLedgerApi['applyNamespacedMigrations'];
  export const recordMigrationAdoption: WorkshopMigrationLedgerApi['recordMigrationAdoption'];
  export const checksumMigration: WorkshopMigrationLedgerApi['checksumMigration'];
}
