# Package handoff

## Workshop package handoff ready

This phase is complete when the exact npm tarball passes the local release gate
and provides the documented protocol, server, MCP, Site route, UI, migration,
health, and observability surfaces. The package owns runtime
boundaries, schemas, validation, tests, assets, and consumer compatibility.

The downstream Site supplies D1, Diamond health, Taproot persistence and its
authorized-reader boundary, the shared live authorization source with separate
host-issued Task, Memory, authorization-maintenance, and cursor-snapshot domain
guards, opaque cursor cryptography/generation state, identity/capabilities, Waystone
registration, deployment configuration, and any browser endpoints used by the
MCP-status controller. Workshop runtime construction never provisions
infrastructure or applies migrations.

Workshop CI packs released Taproot 0.4.0 source at
`819fe054ebb867e1ca92518bfd3b1aa6c5aa277d` and verifies the typed boundary plus
real native SQLite and persisted D1 runtime behavior. Passing that package gate
still does not assemble or accept a complete Gnolith Site.

## Ownership boundary

Workshop may install its exact tarball in isolated Worker, vinext, Miniflare,
and generic consumers with injected or stubbed peer services. These checks
verify the package's exports, runtime boundaries, and supported-consumer
portability. They neither provision infrastructure nor qualify a complete Site.

The Codex agent creating a Site owns four-package assembly, Site migrations and
bindings, host identity/secrets/configuration, deployment, live probes, and final
acceptance. Site-specific host assets do not belong in the Workshop package.
