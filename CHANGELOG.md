# Changelog

## [0.5.0]

- Replaced the UI/Site/Worker package with the `gnolith-workshop` self-hosted
  executable, one listener, authenticated MCP and BFF, and explicit offline
  bootstrap.
- Generated one 52-operation `gnolith` catalog shared by schemas, MCP, BFF,
  validation, and the generic client.
- Added separate local-bearer and remote-OAuth profiles, fail-closed readiness,
  verified immutable Waystone assets, bounded lifecycle controls, task leases,
  and owner-scoped backup APIs.
- Added a read-only, bounded exact-0.4.2 legacy-owner decoder and owner-bound
  adoption adapter with opaque fragments, migration-ledger evidence, digests,
  and Task/Memory/Prompt/revision contribution counts.
- Coupled task lease claim, release, and completion atomically to canonical
  source/history updates, durable idempotency receipts, and lease audit events.
- Added schema 8 durable credential/bootstrap receipts and an exact Taproot
  authorization-bootstrap owner adapter.
- Added schema 11 sealed authorization administration, durable principal,
  membership, credential/OAuth, audit, and semantic configuration state.
- Added offline semantic configuration with exact revision/fingerprint
  receipts, fail-closed endpoint policy, and truthful degraded/ready status.
- Added public bounded local-filesystem ResourceBlob backup/restore ports with
  private content-addressed paths, verified staging, collision checks, rebinds,
  rollback, and symlink/traversal defenses.
- Made owner restore collision-safe and repeatable on a fresh current target,
  preserving one canonical copy of task idempotency receipts, revisions, and
  outcomes while rejecting inconsistent duplicates.
- Distinguished schema-declared authorization administration targets from the
  transport-authenticated caller, serialized manual and automatic search
  materialization, fenced simultaneous task claims, and rejected encoded
  asset traversal before Node URL normalization.
- Defined the exact domain-separated local-bearer credential digest in the
  public operation schema, exposed its safe digest helper, hardened
  recursively encoded dot-segment rejection, and returned bounded manual
  materialization job/result/health evidence.
- Removed legacy operation aliases, UI and CSS exports, Site route factories,
  stdio transport, and the parallel hand-written MCP catalog.

All notable changes follow Keep a Changelog and Semantic Versioning.

## [0.4.2] - 2026-07-22

### Added

- Expose bounded `task_history` and `memory_history` reads through the process
  core, MCP, HTTP/browser client, and packed public composition declarations.

### Security

- Validate canonical revision identity, authorize every historical snapshot,
  and recheck the exact current record plus live authorization immediately
  before Task, Memory, or Prompt history content is returned.

## [0.4.1] - 2026-07-22

### Fixed

- Widen the optional Waystone peer range through compatible 0.2.x releases and
  qualify the released Waystone 0.2.0 structural plugin adapter with an exact
  disposable npm/declaration/runtime consumer.

## [0.4.0] - 2026-07-22

### Added

- Canonical Task, Memory, and Prompt search producer domains using Taproot's
  public registration, policy-authority, sealed-mutation, legacy-adoption,
  materialization, hydration, and semantic-search contracts.
- Durable Prompt CRUD/history plus richer Task and Memory metadata and revision
  snapshots across protocol, HTTP, MCP, and client surfaces.
- Search and bounded search-administration transport surfaces, including
  rebuild, retry, adoption, and semantic lifecycle operations.

### Changed

- Require exact-compatible Taproot 0.4.x and Workshop schema version 6.
- Seal every Task, Memory, and Prompt mutation atomically with its canonical
  Taproot source event; writes fail closed when search integration is absent.

### Security

- Enforce source-revision/predecessor checks, policy revisions, workspace and
  installation isolation, bounded adoption, and authorization-aware hydration.

## [0.3.3] - Unreleased

### Fixed

- Run the real publish dry-run boundary after clean artifact preparation and
  distinguish the expected untagged failure from successful tagged validation.
- Trigger OIDC publication from an annotated version tag and create the
  immutable GitHub Release only after npm publication and provenance succeed.

## [0.3.2] - GitHub-only 2026-07-22

> The immutable GitHub tag and Release exist, but npm `0.3.2` was never
> published: its OIDC workflow stopped at the pre-publication package gate.

### Changed

- Correct the package release boundary so Workshop owns package provenance,
  security, runtime, and packed-peer acceptance without requiring or performing
  complete Gnolith Site assembly, deployment, or acceptance.

## [0.3.1] - Unreleased

### Changed

- Pin patched development-only `sharp@0.35.3` and
  `@hono/node-server@2.0.11`, with mandatory Miniflare native-image and MCP
  Node HTTP bridge compatibility smokes plus a zero-total dependency audit.

## [0.3.0] - Unreleased

### Added

- Transport-neutral process-local core and authorized MCP tool dispatcher.
- Portable Workshop migration runner and D1/node:sqlite behavioral parity.
- Monotonic task and memory revisions with legacy timestamp compatibility.
- Durable, leased, resumable onboarding checkpoints with replay-safe writers.
- Shared Taproot-shaped installation/workspace/principal authorization for
  Tasks and Memories, including canonical visibility scopes and bounded legacy
  backfill readiness tooling.
- Durable bounded Task/Memory pagination snapshots with metadata-only entries,
  host-keyed binding digests, expiry cleanup, and authorization/search-generation
  revocation.

### Changed

- Health exposes neutral `checks.persistence` while retaining `checks.d1`.
- HTTP/Site runtime remains source-compatible over the new core seam.
- Taproot-backed statement creation and revision tools now require explicit,
  nonblank authored text and forward it without normalization. Initial Item
  claims are covered; statement removal remains text-exempt.
- The Taproot adapter now exposes an exact typed consumer contract with a
  commit-pinned packed-peer conformance gate.
- All Task/Memory service reads prefilter authorization before hydration and
  recheck live state afterward. Legacy rows are quarantined; unscoped public
  SPARQL/entity search fail closed; generic admin does not imply `search:admin`.
- Backfill and cursor-snapshot writes now use separate exact Taproot domain
  guards; released Taproot conformance covers packed native SQLite and persisted
  D1 restart behavior.

## [0.1.1] - 2026-07-20

### Changed

- Separate isolated package-runtime canaries from complete Gnolith Site
  acceptance and exclude host fixtures from the published package.
- Enforce LF checkouts and verify formatting under Windows
  `core.autocrlf=true`.
- Generate one content-addressed package artifact with machine-verifiable source,
  environment, integrity, and file-manifest provenance for consumer and release
  gates.

## [0.1.0] - 2026-07-20

### Added

- D1-backed tasks and memories, atomic claims, optimistic updates, archival,
  completion, and administrative abandoned-claim reset.
- Ephemeral task packets with bounded current SPARQL context and memory
  resolution.
- Shared SPARQL policy, host-injected Diamond query boundary, and Taproot
  knowledge adapter.
- Authenticated stateless Streamable HTTP MCP with deterministic schemas.
- Web route factories, browser client, Waystone plugin, React UI, onboarding
  seed planning, health, diagnostics, semantic probe support, migrations, and
  release gates.
