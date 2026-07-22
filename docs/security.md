# Security considerations and threat assumptions

Workshop assumes the public Internet, hostile prompts/tool inputs, concurrent
agents, stale revisions, and compromised browser origins. It does not assume a
trusted MCP client merely because a URL is known.

- Hosts authenticate every request and inject Taproot's shared live
  authorization authority. Every Task, Memory, Packet, and Knowledge boundary
  requires a full authorization context.
- Same-origin is the default; explicit CORS and MCP Origin validation prevent
  DNS-rebinding/cross-origin access.
- D1 values use bound statements. Conditional writes enforce concurrency.
- Candidate Task/Memory reads are authorization-filtered in SQL before content
  hydration and rechecked afterward. Missing, cross-installation, and denied
  records share one non-disclosing denial.
- Unscoped public SPARQL execution fails closed. Entity search is available only
  through Taproot's authorized-reader candidate and hydration boundary.
- Knowledge writes are unavailable and unadvertised until shared Taproot policy
  persistence and atomic mutation conformance are complete.
- Request/content/query/page/tool limits reduce resource exhaustion.
- Public errors omit stacks and internals. Observability hooks must never log
  tokens, secrets, entire packets, sensitive source bodies, or arbitrary MCP
  request bodies.
- Detailed health requires exact `admin`. Mutating semantic probes require
  exact `admin`, `task-write`, and `memory-write`; claim reset requires exact
  `admin` and `task-write`. Legacy authorization backfill requires exact
  `search:admin`. Generic `admin` never implies another capability.
- React renders prompts/results/memories as text; no raw HTML path is provided.

Workshop's package boundary assumes the consumer supplies correct principals,
protects bearer tokens and database handles, and configures intentional origins.
Run `npm audit --omit=dev`, dependency review, code scanning, and focused
authorization/context-query/MCP review before every public package release.

## 0.1 focused review record

The 2026-07-20 local review verified server-side capability checks, same-origin
CORS defaults, prepared D1 statements, bounded streaming request reads, bounded
static context-query validation, structured non-stack errors, safe React text rendering, no
administrative reset MCP tool, telemetry that cannot alter domain outcomes,
clean production dependency audit, isolated Worker package-consumer build, and
exact tarball contents. The Codex agent creating a Site owns live binding scope,
edge rate limits, real Taproot policy/projection, deployed authentication,
deployment, and complete-Site security acceptance.
