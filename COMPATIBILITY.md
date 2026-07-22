# Compatibility

Workshop 0.3.x targets:

- Diamond `>=0.4.0 <0.5.0` through injected SQLite/query services
- Taproot `>=0.3.0 <0.4.0`; this breaking line includes the shared
  authorization context/visibility contract, authorized reader, mandatory
  authored `Statement.text`, and text-bearing statement revision methods.
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

CI also packs released Taproot 0.3.0 source commit
`9b7eb5de694e6020ce8466e01687b8077fbf915c` and checks bidirectional structural
compatibility for authorization contexts and visibility scopes, the real
authorized reader, and host-capability-bound Workshop mutation, maintenance,
and cursor guards. The packed runtime lane exercises native SQLite and persisted
Miniflare D1, including D1 disposal/recreation and cursor continuation. It also
asserts that raw repository/deep-result surfaces are absent. This
package-to-package lane detects contract drift without provisioning or accepting
a complete Site.

The Codex agent creating a Site owns the compatibility of the complete host
bundle, including its chosen peer entry points, runtime flags, infrastructure,
and deployment configuration. Compatibility range changes still require a
documented Workshop release.
