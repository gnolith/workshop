# Authorization foundation ledger

Workshop 0.3.0 establishes the package-local authorization prerequisites for a
future unified search/indexing implementation. It does not claim that unified
search, indexing, or complete-Site acceptance is finished.

## Implemented here

- Exact Taproot-shaped authorization contexts and canonical CNF visibility.
- One host-injected live authorization source plus separate atomic Task and
  Memory mutation methods backed by Taproot guards bound to exact `task-write`
  and `memory-write`. Separate exact `search:admin` maintenance guards fence
  Task and Memory authorization backfill, and an exact `read` guard fences
  cursor snapshot creation. Workshop has no independent authorization table or
  revision authority, and never elevates either domain to `knowledge:write`.
  The host adapter maps Taproot authorization rejections to Workshop's generic
  `forbidden` response; it must not disguise unrelated database failures as
  authorization denials.
- Durable Task and Memory installation, owner, workspace, visibility, and
  authorization-revision metadata.
- Installation/visibility SQL candidate filtering before hydration, followed by
  policy and live-state rechecks.
- Durable bounded pagination snapshots containing only IDs, revisions, and
  ordering metadata; host-keyed domain-separated binding digests; host-sealed
  generation/query/domain/grant-bound cursor tokens; cross-installation
  isolation; and immediate authorization/search-generation revocation.
- Fail-closed quarantine for legacy rows plus an explicit bounded, resumable,
  host-only backfill requiring exact `search:admin`.
- Authorized Taproot entity reads and candidate search through the merged
  `AuthorizedTaprootReader` contract. Knowledge writes and unscoped SPARQL
  execution are unavailable through public Workshop operations.

These changes advance the authorization portions of the system foundations
tracked as B03, D03, H01, and H07. They do not complete those broad foundations.

## Deliberately not implemented

- A unified Task/Memory/entity index or ranking algorithm.
- A scoped Diamond graph-query interface suitable for public Workshop SPARQL or
  packet context queries.
- The host cursor-key lifecycle, rotation, and durable generation store.
- Public onboarding. Legacy journals are retained only for migration history
  and are not exported or discoverable through core, HTTP, MCP, or UI surfaces.
- Site assembly, provisioning, deployment, or complete-system acceptance.

Seedbed (or another host assembler) must inject the shared authorization source,
implement the five exact atomic Workshop guard ports against the same persisted
policy, provide the cursor codec and durable generation state, and coordinate
migrations. Workshop's narrow port is a package contract, not complete-Site
assembly or acceptance. Diamond must expose a scoped graph boundary before
Workshop can safely enable context-query execution.
