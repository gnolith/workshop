# Migrations and upgrade policy

Workshop owns five exact migrations: `0001_workshop` creates tasks and
memories, `0002_revisions` adds monotonic concurrency tokens, and
`0003_resumable_onboarding` adds durable run and step checkpoints.
`0004_authorization` adds installation, owner, workspace, canonical visibility,
and authorization-revision fields plus candidate-selection indexes.
`0005_cursor_snapshots` adds durable bounded cursor snapshots, metadata-only
entries, expiry cleanup support, and cascading entry deletion. Every entry
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
schema version. Version 4 validation includes the exact authorization table
constraints and composite Memory key; version 5 validates the exact cursor
tables, foreign key, and expiry index. Weakened near-miss schemas and schema
metadata drift are rejected without recording ledger adoption.

Pre-v4 Task and Memory rows remain deliberately quarantined with null metadata.
The host may inspect readiness and run an explicit bounded, resumable backfill
through the server API with exact `search:admin`. The host executes each batch
behind a domain-specific Taproot maintenance guard; authorization changes at the
fence leave all selected metadata untouched. Nothing auto-assigns legacy content
to an installation or workspace.

Ordinary process commands must not silently migrate an existing database.
Seedbed owns migration ordering, lifecycle, backup, and recovery. Patch releases
do not make destructive schema changes. Additive upgrades use a new monotonic
file, update the manifest/schema version, and require clean and previous-version
upgrade tests. Destructive changes require explicit migration and compatibility
notes.
