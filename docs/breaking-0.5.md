# Migrating to Workshop 0.5

Workshop 0.5 is an architecture reset. Replace Site/Worker route factories and
the React UI with the `gnolith-workshop` executable. Remove imports of
`@gnolith/workshop/site`, `@gnolith/workshop/ui`, and the CSS export. Waystone
may instead provide a verified immutable asset manifest mounted by the same
Workshop listener at the canonical `/app` prefix.

Replace domain-specific browser-client calls with the generated generic client:

```ts
await client.call('get_task', { taskId });
```

Use `/api/v1/operations/<operation>` for BFF calls and `/mcp` for Streamable
HTTP MCP. There is no stdio transport, GET SSE listener, alternate MCP path, or
`workshop` server identity.

The complete machine-readable old-name mapping is
`schemas/legacy-operation-names-v1.json`. Granular knowledge mutations map to
`mutate_entity`; old search maintenance names map to the discriminated
`search_admin`; SPARQL dry run maps to `query_sparql` with `dryRun: true`.
SPARQL Update and abandoned-claim reset have no replacement.

Task claim handling now uses opaque expiring leases. Persist the returned lease
token only in protected worker state and supply it with the exact task revision
to update, complete, or idempotently release the lease. Never retry a release
with a different payload under the same idempotency key.

Migrations are explicit. An operator runner calls the public Workshop migration
library after Diamond and Taproot migrations; `serve` will fail closed rather
than apply pending migrations. Run offline `bootstrap-v1` only after all owner
migrations succeed.

Schema 11 is required for bootstrap because the Workshop owner adapter commits
the local credential digest and immutable bootstrap receipt in Taproot's sealed
authorization-bootstrap transaction.

Run `configure-semantics-v1 --config <path> --input <json-file>` after
bootstrap and before `serve`. The configuration file contains selector IDs, not
credential bytes. Readiness exposes the exact semantic revision, fingerprint,
and ready state without weakening lexical search.

For filesystem resource backup and restore, instantiate
`createLocalFilesystemResourceBlobPortsV1({ root })` from
`@gnolith/workshop/backup` and pass its `backup` and `restore` ports to the
Taproot/Seedbed orchestration. Do not construct blob paths from reference IDs.

Installation restore remains owner-opaque. Call
`createWorkshopBackupApi(...).importBackup(document)` or the bound owner
handle's `importOwnedState(...)`; never parse Workshop tables in the
orchestrator. Import atomically replaces the bound installation's Workshop
state, restores each logical idempotency record once, preserves receipts,
revisions, and outcomes, expires live leases, and rejects inconsistent
duplicates.

To transfer an existing exact 0.4.2 database, use
`decodeWorkshopLegacyOwnerV042` and `adoptWorkshopLegacyOwnerV042` from
`@gnolith/workshop/backup`. The decoder requires exact 0.4.2/schema-6 and
Workshop migration-ledger evidence, is read-only, and returns a bounded opaque
Workshop owner fragment with Task, Memory, Prompt, and owned-revision counts.
There is no legacy-adoption CLI and the adapter has no Seedbed table knowledge.
