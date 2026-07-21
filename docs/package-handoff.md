# Package handoff

## Workshop package handoff ready

This phase is complete when the exact npm tarball passes the local release gate
and provides the documented protocol, server, MCP, Site route, UI, migration,
health, observability, and onboarding surfaces. The package owns runtime
boundaries, schemas, validation, tests, assets, and consumer compatibility.

The downstream Site supplies D1, Diamond query execution, Taproot persistence,
identity/capabilities, Waystone registration, deployment configuration, and any
browser endpoints used by the injected onboarding and MCP-status controllers.
Workshop runtime construction never provisions infrastructure or applies
migrations.

## Ownership boundary

Workshop may install its exact tarball in isolated Worker, vinext, Miniflare,
and generic consumers with injected or stubbed peer services. These checks
verify the package's exports, runtime boundaries, and supported-consumer
portability. They neither provision infrastructure nor qualify a complete Site.

The Codex agent creating a Site owns four-package assembly, Site migrations and
bindings, host identity/secrets/configuration, deployment, live probes, and final
acceptance. Site-specific host assets do not belong in the Workshop package.
