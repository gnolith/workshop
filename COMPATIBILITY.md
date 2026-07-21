# Compatibility

Workshop 0.2.x targets:

- Diamond `>=0.4.0 <0.5.0` through injected SQLite/query services
- Taproot `>=0.1.0 <0.3.0`
- Waystone plugin contract `>=0.1.0 <0.2.0`
- React `>=19 <20`
- TypeScript `>=5.9 <6`
- MCP protocol `2025-11-25`, with `2025-06-18` and `2025-03-26` negotiation
- MCP TypeScript SDK `1.29.x` for interoperability verification
- vinext `1.0.0-beta.2` (isolated package-consumer target)
- Cloudflare Workers compatibility date `2026-07-20` or later
- Node.js 22 or 24 for development and release tooling

The exact Workshop tarball compiles in isolated vinext/Vite and Worker
consumers. These fixtures inject or stub Diamond, Taproot, identity, and host
bindings; they verify Workshop package compatibility only and perform no remote
deployment. They do not assemble or qualify a complete Gnolith Site.

The Codex agent creating a Site owns the compatibility of the complete host
bundle, including its chosen peer entry points, runtime flags, infrastructure,
and deployment configuration. Compatibility range changes still require a
documented Workshop release.
