# Operational limits

Default limits are exported as `defaultWorkshopLimits` and may be lowered by a
Site:

| Limit                    |                 Default |
| ------------------------ | ----------------------: |
| Description              |                   4 KiB |
| Prompt                   |                 128 KiB |
| Result                   |                 256 KiB |
| Memory content           |                 128 KiB |
| Context queries per task |                      20 |
| Query                    |                  16 KiB |
| SPARQL timeout           |              10 seconds |
| SPARQL results           |                   1,000 |
| MCP/JSON request         |                   1 MiB |
| Tool timeout             |              30 seconds |
| Page size                | 50 default, 200 maximum |

Limits return structured errors. Diamond also enforces algebra and byte bounds.

## Local regression measurements

`npm run performance:check` measures the built package against Miniflare D1 and
fails any common operation above a deliberately generous two-second regression
bound. On 2026-07-20 the reference run measured task search at 81.45 ms, a
one-query packet at 75.40 ms, MCP initialization at 2.04 ms, `tools/list` at
0.45 ms, a knowledge-service call at 0.02 ms, and the compiled UI modules at
14,557 bytes raw / 3,142 bytes gzip. Wrangler reported the complete canary
Worker at 640.24 KiB raw / 122.00 KiB gzip. The final run measured a 38.38 ms
cold bundled-Worker initialize in Miniflare. These are development-machine
baselines, not production latency promises; managed-canary evidence supersedes
them for release decisions.
Workshop does not cache claims. Operators should observe packet duration, task
search, MCP initialize/list, knowledge calls, Worker cold starts, and UI bundle
size before raising limits.
