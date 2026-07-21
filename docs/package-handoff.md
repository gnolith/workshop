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

## Full Gnolith/Codex Site production verification pending downstream integration

Downstream integration must still:

1. Compose exact released Diamond, Taproot, Waystone, and Workshop packages.
2. Apply the canonical Workshop migrations to the managed Site database.
3. Resolve Diamond 0.3.2's `node:events` import for a no-compat Worker target.
4. Decide how to handle vinext's current SSR Node-import warning in the full
   Worker build; Workshop's exact-tarball vinext smoke compiles but does not
   assert full-Site Worker compatibility.
5. Exercise real graph projection, browser identity/permissions, deployed MCP,
   and the intended Codex environment.
6. Feed any integration findings back into a later Workshop refinement.

Those items are integration risks, not unfinished Workshop package-owned work.
