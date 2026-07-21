# Compatibility

Workshop 0.1.x targets:

- Diamond `>=0.3.2 <0.4.0` through the injected query service
- Taproot `>=0.1.0 <0.2.0`
- Waystone plugin contract `>=0.1.0 <0.2.0`
- React `>=19 <20`
- TypeScript `>=5.9 <6`
- MCP protocol `2025-11-25`, with `2025-06-18` and `2025-03-26` negotiation
- MCP TypeScript SDK `1.29.x` for interoperability verification
- vinext `1.0.0-beta.2` (first Codex Sites canary target)
- Cloudflare Workers compatibility date `2026-07-20` or later
- Node.js 22 or 24 for development and release tooling

The exact Workshop tarball compiles in the vinext/Vite App Router canary and its
standalone Worker canary requires no Node compatibility flag. vinext currently
warns about Node imports in its own SSR environment; the downstream full Site
must qualify or resolve that warning. The host-injected Diamond service must
also meet the Worker-safe constraint: Diamond 0.3.2's direct package entry
currently imports `node:events`, so it must not be statically pulled into the
no-compat bundle until that lower-layer contract is corrected. Neither warning
is a Workshop-owned runtime import. Compatibility range changes require a
documented release.
