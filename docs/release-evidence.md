# Workshop 0.1.0 release evidence

## Workshop package handoff ready

Current package decision: **READY**. `npm run check` and
`npm run release:check -- v0.1.0` passed in this working tree on 2026-07-20.
This is a local package handoff decision, not authorization to publish.

| Package-owned gate                           | Evidence                                                                    | Status |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| Format, lint, strict types, tests, coverage  | Complete local gate; 36 tests                                               | PASS   |
| D1 migration, schema, task/memory races      | Miniflare clean-schema and integration tests                                | PASS   |
| SPARQL and Taproot adapter boundary          | Parser, dry-run, delegation, revision tests                                 | PASS   |
| MCP schemas and official client              | Tool inventory plus SDK 1.29 initialize/list/call                           | PASS   |
| Route factories, auth, health, observability | Unit and bundled Worker lifecycle tests                                     | PASS   |
| Waystone UI                                  | Injected-client interaction, permissions, conflict, and accessibility tests | PASS   |
| Workshop Worker no-compat build              | 640.24 KiB / 122.00 KiB gzip; no compatibility flags                        | PASS   |
| Exact npm tarball consumers                  | 89.4 KiB package; public exports, Worker, and vinext App Router             | PASS   |
| Performance, dependency audit, readiness     | Included in `npm run check`                                                 | PASS   |
| Release artifact contents                    | `npm run release:check -- v0.1.0`                                           | PASS   |

The final command output is the source of truth if this document and a later
working-tree state differ.

## Full Gnolith/Codex Site production verification pending downstream integration

No claim is made here for managed D1/R2, a deployed Codex Site, full
Diamond/Taproot graph projection, a live Waystone browser, deployed MCP, or an
intended Codex connection. Diamond 0.3.2's `node:events` import and vinext's SSR
Node-import warning are downstream full-Site compatibility risks. They do not
block the Workshop package handoff because Workshop's own Worker and browser
boundaries are no-compat and exact-tarball verified.
