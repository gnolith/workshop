# Migrations and upgrade policy

Workshop owns three exact migrations: `0001_workshop` creates tasks and
memories, `0002_revisions` adds monotonic concurrency tokens, and
`0003_resumable_onboarding` adds durable run and step checkpoints. Every entry
has a monotonic ID and SHA-256 in `workshopMigrations`; the same canonical SQL
ships under `migrations/`.

Consumers may materialize the manifest through their chosen installer or call
`applyWorkshopMigrations(persistence)` explicitly. Runtime construction never
discovers SQL from disk or creates tables. Health compares `workshop_schema`,
required tables, and indexes through the neutral persistence capability.

The runner uses Diamond 0.4's shared `_gnolith_migrations` ledger under the
`@gnolith/workshop` namespace. Every migration is committed atomically with its
Diamond-computed checksum. Unknown IDs, checksum drift, partial histories, and
newer versions fail closed. A pre-ledger Workshop database is adopted only after
Workshop verifies the tables and revision columns required by its recorded
schema version.

Ordinary process commands must not silently migrate an existing database.
Seedbed owns migration ordering, lifecycle, backup, and recovery. Patch releases
do not make destructive schema changes. Additive upgrades use a new monotonic
file, update the manifest/schema version, and require clean and previous-version
upgrade tests. Destructive changes require explicit migration and compatibility
notes.
