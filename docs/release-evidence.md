# Workshop 0.2.2 release evidence

## Workshop package handoff ready

Current local package decision: **READY FOR REVIEW**. `npm run check` and
`npm run artifact:verify` passed in this working tree on 2026-07-21. The stricter
release check correctly rejects this uncommitted, untagged tree. This is not
authorization to commit, tag, push, or publish.

The current verification environment was Microsoft Windows NT 10.0.26200.0,
Node.js v24.14.0, npm 11.9.0, and Git 2.45.1.windows.1. System Git supplied
`core.autocrlf=true`; the repository `.gitattributes` policy resolved tracked
text to `eol: lf`, and the normal `npm run format:check` command passed. CI also
defines a bounded Windows regression that sets `core.autocrlf=true` before
checkout and runs the same format command after `npm ci`.

| Package-owned gate                           | Evidence                                                                    | Status           |
| -------------------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| Format, lint, strict types, tests, coverage  | Complete local gate; 71 tests                                               | PASS             |
| D1 migration, schema, task/memory races      | Miniflare clean-schema and integration tests                                | PASS             |
| Embedded SQLite parity                       | Exact Diamond/Workshop tarballs; reopen, migrations, health, contention     | PASS             |
| SPARQL and Taproot adapter boundary          | Parser, dry-run, delegation, revision tests                                 | PASS             |
| MCP schemas and official client              | Tool inventory plus SDK 1.29 initialize/list/call                           | PASS             |
| Route factories, auth, health, observability | Unit and isolated package-runtime lifecycle tests                           | PASS             |
| Waystone UI                                  | Injected-client interaction, permissions, conflict, and accessibility tests | PASS             |
| Isolated Worker package consumer             | 640.28 KiB / 122.00 KiB gzip; no compatibility flags                        | PASS             |
| Exact npm tarball consumers                  | One prepared artifact; generic, Worker, and vinext isolated consumers       | PASS             |
| Artifact provenance                          | Schema, commit/worktree, hashes, parsed tar manifest/exports/migrations     | PASS             |
| Performance, dependency audit, readiness     | Included in `npm run check`                                                 | PASS             |
| Tagged release invariant                     | Requires clean matching annotated tag; current dirty/no-tag tree rejected   | EXPECTED BLOCKED |

The final command output is the source of truth if this document and a later
working-tree state differ.

The machine-verifiable record beside the ignored archive under `.release/` is
the source of truth for the exact commit/worktree state, environment, artifact
SHA-256 and npm integrity, and sorted file manifest. The current local record is
dirty because these changes are not committed. It must be regenerated after the
final commit and annotated tag before publication. The publish workflow retains
the provenance and versioned schema as non-replaceable GitHub Release assets.

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
