# Migrations and upgrade policy

Workshop migration `0001_workshop` creates only tasks, memories, schema metadata,
and justified state/role/update indexes. It has a monotonic ID and SHA-256 in
`workshopMigrations`. The same canonical SQL is shipped under `migrations/`.

Consumers can verify the checksum and materialize the SQL through their chosen
installer. Runtime services never discover SQL from disk or create tables.
Health compares `workshop_schema`, required tables, and indexes.

Patch releases do not make destructive schema changes. Additive upgrades use a
new monotonic file, update the manifest/schema version, and require clean and
previous-version upgrade tests. Destructive changes require explicit migration
and compatibility notes. The Site-creating agent owns operational backup and
rollback procedures.
