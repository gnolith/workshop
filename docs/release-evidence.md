# Workshop 0.3.2 release evidence

## Workshop package handoff ready

Current local package decision: **PACKAGE GATES PASS; TAGGED RELEASE EVIDENCE
PENDING**.
`npm run check` and `npm run artifact:verify` passed in this working tree on
2026-07-22. Public `@gnolith/taproot` 0.3.0 exposes npm SLSA provenance for the
exact source commit `9b7eb5de694e6020ce8466e01687b8077fbf915c`. A clean matching
annotated Workshop tag and regenerated artifact provenance remain required.
Normal `npm publish` derives the matching tag from the package version and runs
both the Taproot provenance gate and Workshop's clean/tagged provenance check.
This is not authorization to tag or publish.

The current verification environment was Microsoft Windows NT 10.0.26200.0,
Node.js v24.14.0, npm 11.9.0, and Git 2.45.1.windows.1. System Git supplied
`core.autocrlf=true`; the repository `.gitattributes` policy resolved tracked
text to `eol: lf`, and the normal `npm run format:check` command passed. CI also
defines a bounded Windows regression that sets `core.autocrlf=true` before
checkout and runs the same format command after `npm ci`.

| Package-owned gate                           | Evidence                                                                     | Status           |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| Format, lint, strict types, tests, coverage  | 107 tests; source 94.23% statements / 83.72% branches / 90.47% functions     | PASS             |
| D1 migration, schema, task/memory races      | Miniflare clean-schema and integration tests                                 | PASS             |
| Embedded SQLite parity                       | Exact Diamond/Workshop tarballs; reopen, migrations, health, contention      | PASS             |
| Released Taproot runtime boundary            | Exact 9b7 packed peer; typed, native SQLite, persisted D1 restart/read lanes | PASS             |
| Context-query and Taproot reader boundary    | Static parser, fail-closed packets, authorized-reader tests                  | PASS             |
| MCP schemas and official client              | Tool inventory plus SDK 1.29 initialize/list/call                            | PASS             |
| Route factories, auth, health, observability | Unit and isolated package-runtime lifecycle tests                            | PASS             |
| Waystone UI                                  | Injected-client interaction, permissions, conflict, and accessibility tests  | PASS             |
| Isolated Worker package consumer             | 690.14 KiB / 131.38 KiB gzip; 37.37 ms cold initialize                       | PASS             |
| Exact npm tarball consumers                  | One prepared artifact; generic, Worker, and vinext isolated consumers        | PASS             |
| Artifact provenance                          | Schema, commit/worktree, hashes, parsed tar manifest/exports/migrations      | PASS             |
| Dev-tool compatibility and full audit        | Hono Node HTTP bridge; Sharp PNG-to-WebP; exactly zero vulnerabilities       | PASS             |
| Performance, production audit, readiness     | Included in `npm run check`                                                  | PASS             |
| Tagged release invariant                     | Requires clean matching annotated tag; current dirty/no-tag tree rejected    | EXPECTED BLOCKED |
| Complete-Site acceptance                     | Assembly, provisioning, deployment, and acceptance are host-agent owned      | OUT OF SCOPE     |

The final command output is the source of truth if this document and a later
working-tree state differ.

The machine-verifiable record beside the ignored archive under `.release/` is
the source of truth for the exact commit/worktree state, environment, artifact
SHA-256 and npm integrity, and sorted file manifest. Its `dirty`, commit, and tag
fields are authoritative for the state in which it was generated. It must be
regenerated after the final commit and annotated tag before publication. The
publish workflow retains the provenance and versioned schema as non-replaceable
GitHub Release assets.

The exact clean-head full-gate performance run measured Task search at 485.02
ms, a one-query packet at 307.97 ms, MCP initialization at 1.82 ms,
`tools/list` at 0.32 ms, and an authorized Knowledge call at 0.19 ms. Compiled UI modules were
42,828 bytes raw / 7,745 bytes gzip. These are package regression measurements,
not complete-Site latency claims.

## Evidence boundary

The Worker, vinext, and Miniflare results are isolated package-runtime consumers
with injected or stubbed peer services. This evidence does not qualify a
complete Gnolith Site.

The vinext SSR build passed but warned about Node imports originating in vinext
and React DOM. That counterevidence remains a full-Site compatibility item; the
isolated package check is not evidence that a deployed Site needs no additional
runtime configuration.

The Codex agent creating a Site owns complete package assembly, managed bindings and
migrations, host identity and secrets, deployment configuration, real graph
projection, live Waystone/browser/MCP/Codex probes, and final acceptance.
Workshop CI must not provision, deploy, assemble, or accept that complete Site.
