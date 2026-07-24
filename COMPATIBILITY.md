# Compatibility

Workshop 0.5 is a breaking reset and requires Diamond and Taproot 0.5 candidate
APIs. It supports Node.js 22 or newer with native SQLite or an injected D1-like
persistence adapter.

Removed surfaces: `@gnolith/workshop/ui`, `@gnolith/workshop/site`, CSS exports,
Worker-specific handlers, stdio MCP, and the legacy tool dispatcher. Removed
operation aliases are documented only in
`schemas/legacy-operation-names-v1.json` and are never accepted at runtime.

Waystone is optional static content. Workshop serves only a verified immutable
`waystone-assets-v1` manifest and does not import or initialize a Waystone
runtime.
