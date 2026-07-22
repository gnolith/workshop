# Workshop 0.4.1 release evidence

## Workshop package handoff ready

Current local package decision: **PACKAGE GATES PASS; TAGGED RELEASE EVIDENCE
PENDING**.
Workshop 0.4.1 requires public `@gnolith/taproot` 0.4.0 with exact npm
integrity `sha512-yYxbrUNnu74zBaxHoywGlgeG2LFz4HMzi2RLcsq83/JVEIkwbWvWZ8tuLpxFYxTAgTXG1/FHddgEJStRupe54A==`
and npm SLSA provenance resolving annotated `v0.4.0` to source commit
`819fe054ebb867e1ca92518bfd3b1aa6c5aa277d`. A clean matching
annotated Workshop tag and regenerated artifact provenance remain required.
Normal `npm publish` derives the matching tag from the package version and runs
both the Taproot provenance gate and Workshop's clean/tagged provenance check.
This is not authorization to tag or publish.

The trusted tag-driven workflow creates the immutable GitHub Release only after
the verified archive is public through npm OIDC and exact npm provenance has
been revalidated. A manually pre-created Release is not a valid trigger.

The immutable GitHub `v0.3.2` tag and Release are historical only. The OIDC
workflow stopped before npm publication, so `@gnolith/workshop@0.3.2` and its
npm provenance do not exist and must not be consumed.

The current verification environment was Microsoft Windows NT 10.0.26200.0,
Node.js v24.14.0, npm 11.9.0, and Git 2.45.1.windows.1. System Git supplied
`core.autocrlf=true`; the repository `.gitattributes` policy resolved tracked
text to `eol: lf`, and the normal `npm run format:check` command passed. CI also
defines a bounded Windows regression that sets `core.autocrlf=true` before
checkout and runs the same format command after `npm ci`.

| Package-owned gate                             | Evidence                                                                      | Status           |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| Format, lint, strict types, tests, coverage    | 119 tests; source 88.33% statements / 82.35% branches / 91.30% functions      | PASS             |
| D1 migration, schema, task/memory/prompt races | Miniflare clean-schema and integration tests                                  | PASS             |
| Embedded SQLite parity                         | Exact Diamond/Workshop tarballs; reopen, migrations, health, contention       | PASS             |
| Released Taproot runtime boundary              | Exact 819fe packed peer; Task/Memory/Prompt typed and runtime lanes           | PASS             |
| Context-query and Taproot reader boundary      | Static parser, fail-closed packets, authorized-reader tests                   | PASS             |
| MCP schemas and official client                | Tool inventory plus SDK 1.29 initialize/list/call                             | PASS             |
| Route factories, auth, health, observability   | Unit and isolated package-runtime lifecycle tests                             | PASS             |
| Waystone UI                                    | UI tests plus public Waystone 0.2.0 normal-install/declaration/registry probe | PASS             |
| Isolated Worker package consumer               | 742.64 KiB / 139.85 KiB gzip; 40.82 ms cold initialize                        | PASS             |
| Exact npm tarball consumers                    | One prepared artifact; generic, Worker, and vinext isolated consumers         | PASS             |
| Artifact provenance                            | Schema, commit/worktree, hashes, parsed tar manifest/exports/migrations       | PASS             |
| Dev-tool compatibility and full audit          | Hono Node HTTP bridge; Sharp PNG-to-WebP; exactly zero vulnerabilities        | PASS             |
| Performance, production audit, readiness       | Included in `npm run check`                                                   | PASS             |
| Tagged release invariant                       | Requires clean matching annotated tag; current clean/no-tag head rejected     | EXPECTED BLOCKED |
| Complete-Site acceptance                       | Assembly, provisioning, deployment, and acceptance are host-agent owned       | OUT OF SCOPE     |

The final command output is the source of truth if this document and a later
working-tree state differ.

The machine-verifiable record beside the ignored archive under `.release/` is
the source of truth for the exact commit/worktree state, environment, artifact
SHA-256 and npm integrity, and sorted file manifest. Its `dirty`, commit, and tag
fields are authoritative for the state in which it was generated. It must be
regenerated after the final commit and annotated tag before publication. The
publish workflow retains the provenance and versioned schema as non-replaceable
GitHub Release assets.

Final performance and artifact measurements must be copied from the clean,
tagged 0.4.1 gate. Historical measurements are not release evidence for this
version.

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
