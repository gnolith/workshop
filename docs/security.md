# Security considerations and threat assumptions

Workshop assumes the public Internet, hostile prompts/tool inputs, concurrent
agents, stale revisions, and compromised browser origins. It does not assume a
trusted MCP client merely because a URL is known.

- Hosts authenticate every MCP request and authorize every mutation.
- Same-origin is the default; explicit CORS and MCP Origin validation prevent
  DNS-rebinding/cross-origin access.
- D1 values use bound statements. Conditional writes enforce concurrency.
- SPARQL is parsed once through the shared policy; updates and uncontrolled
  federation are rejected and execution/results are bounded.
- Knowledge writes only call Taproot with expected revisions.
- Request/content/query/page/tool limits reduce resource exhaustion.
- Public errors omit stacks and internals. Observability hooks must never log
  tokens, secrets, entire packets, sensitive source bodies, or arbitrary MCP
  request bodies.
- Detailed health, semantic probes, and claim reset require admin.
- React renders prompts/results/memories as text; no raw HTML path is provided.

Host risks remain: identity-provider correctness, bearer token storage, D1/R2
binding scope, rate limiting, source-data classification, Taproot policy, and
deployment secrets. Run `npm audit --omit=dev`, dependency review, code scanning,
and focused auth/SPARQL/MCP review before every public release.

## 0.1 focused review record

The 2026-07-20 local review verified server-side capability checks, same-origin
CORS defaults, prepared D1 statements, bounded streaming request reads, bounded
SPARQL execution, structured non-stack errors, safe React text rendering, no
administrative reset MCP tool, telemetry that cannot alter domain outcomes,
clean production dependency audit, clean Worker bundle, and exact tarball
contents. Live binding scope, edge rate limits, real Taproot policy/projection,
and deployed authentication remain canary release gates rather than claims made
by the package alone.
