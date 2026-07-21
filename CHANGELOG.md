# Changelog

All notable changes follow Keep a Changelog and Semantic Versioning.

## [0.2.3] - Unreleased

### Added

- Transport-neutral process-local core and authorized MCP tool dispatcher.
- Portable Workshop migration runner and D1/node:sqlite behavioral parity.
- Monotonic task and memory revisions with legacy timestamp compatibility.
- Durable, leased, resumable onboarding checkpoints with replay-safe writers.

### Changed

- Health exposes neutral `checks.persistence` while retaining `checks.d1`.
- HTTP/Site runtime remains source-compatible over the new core seam.

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
