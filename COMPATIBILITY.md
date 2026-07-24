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
runtime. The canonical safe mount is `/app`; service and protocol routes remain
reserved.

Semantic configuration accepts OpenAI-compatible and Ollama-compatible
providers with SQLite or Qdrant vectors. Ollama remains degraded/unavailable
until a separately supplied immutable model is actually ready; Workshop never
pulls a floating model or invents a model digest.
