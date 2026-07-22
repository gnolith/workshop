# Operational limits

Default limits are exported as `defaultWorkshopLimits` and may be lowered by a
Site:

| Limit                     |                 Default |
| ------------------------- | ----------------------: |
| Description               |                   4 KiB |
| Prompt                    |                 128 KiB |
| Result                    |                 256 KiB |
| Memory content            |                 128 KiB |
| Linked memories per task  |                     100 |
| Context queries per task  |                      20 |
| Query                     |                  16 KiB |
| MCP/JSON request          |                   1 MiB |
| Tool timeout              |              30 seconds |
| Page size                 | 50 default, 200 maximum |
| Cursor candidate snapshot |           1,000 entries |
| Cursor token              |                   8 KiB |
| Cursor snapshot lifetime  |              15 minutes |
| Expired snapshot cleanup  |    100 per new snapshot |

Limits return structured errors. A query with more than 1,000 visible
candidates fails generically instead of truncating or disclosing a count.
Cursor snapshots contain only IDs, revisions, ordering timestamps, and binding
digests; they never contain Task or Memory text. Stored context queries are
statically validated but are not executed.

## Local regression measurements

`npm run performance:check` measures the built package against Miniflare D1 and
fails any common operation above a deliberately generous two-second regression
bound. On 2026-07-21 the full remediation gate measured Task search at 486.27
ms, a one-query packet at 309.45 ms, MCP initialization at 1.79 ms, `tools/list`
at 0.31 ms, and a Knowledge-service call at 0.18 ms. Compiled UI modules were
42,828 bytes raw / 7,745 bytes gzip. The isolated Workshop Worker package was
689.23 KiB raw / 131.15 KiB gzip and initialized in 37.4 ms in local Miniflare.
These are development-machine package regression baselines, not complete-Site
or production latency claims.
Workshop does not cache claims. Operators should observe packet duration, task
search, MCP initialize/list, knowledge calls, runtime startup, and UI bundle size
before raising limits. The Site-creating agent owns deployed performance
acceptance.
