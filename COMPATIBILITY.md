# Compatibility

Workshop 0.4.x targets:

- Diamond `>=0.4.0 <0.5.0` through injected SQLite/query services
- Taproot `>=0.4.0 <0.5.0`; this breaking line includes canonical external
  Task, Memory, and Prompt producer registration, sealed atomic mutations,
  bounded legacy adoption, authorized hydration, durable materialization, and
  semantic-search administration.
- Waystone plugin contract `>=0.1.0 <0.3.0`; released Waystone 0.2.x accepts
  Workshop's structural plugin shape through its public
  `WorkshopCompatibleWaystonePlugin` and `createWaystoneRegistry` boundary.
- React `>=19 <20`
- TypeScript `>=5.9 <6`
- MCP protocol `2025-11-25`, with `2025-06-18` and `2025-03-26` negotiation
- MCP TypeScript SDK `1.29.x` for interoperability verification
- vinext `1.0.0-beta.2` (isolated package-consumer target)
- Cloudflare Workers compatibility date `2026-07-20` or later
- Node.js 22 or 24 for development and release tooling

The exact Workshop tarball compiles in isolated vinext/Vite and Worker
consumers. A separate disposable consumer installs the exact tarball with
public Waystone 0.2.0 and React 19 through normal npm peer resolution, compiles
the public declarations, and registers the Workshop plugin through Waystone's
public compatibility adapter. These fixtures inject or stub Diamond, Taproot,
identity, and host bindings; they verify Workshop package compatibility only
and perform no remote deployment. They do not assemble or qualify a complete
Gnolith Site.

CI also packs released Taproot 0.4.0 source commit
`819fe054ebb867e1ca92518bfd3b1aa6c5aa277d` and checks bidirectional structural
compatibility for authorization contexts and visibility scopes, the real
authorized reader, host-capability-bound guards, and all three Workshop search
producer domains. The packed runtime lane exercises native SQLite and persisted
Miniflare D1, including D1 disposal/recreation and cursor continuation. It also
asserts that raw repository/deep-result surfaces are absent. This
package-to-package lane detects contract drift without provisioning or accepting
a complete Site.

The Codex agent creating a Site owns the compatibility of the complete host
bundle, including its chosen peer entry points, runtime flags, infrastructure,
and deployment configuration. Compatibility range changes still require a
documented Workshop release.
