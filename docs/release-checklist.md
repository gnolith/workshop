# Release checklist

## Workshop package handoff

1. Confirm the version, peer ranges, changelog, license, and public exports.
2. Run `npm ci && npm run check` on supported Node releases.
3. Verify migration order, checksums, clean application, and upgrade behavior.
4. Run `npm run artifact:prepare` once; retain its generated commit, environment,
   SHA-256, npm integrity, and file-manifest provenance.
5. Install that existing artifact in generic and isolated Worker/vinext
   consumers with injected or stubbed peers, then run `artifact:verify`.
6. Confirm the isolated Workshop package consumer needs no undeclared runtime
   compatibility flags.
7. Audit MCP tool descriptions/schemas, browser/server dependency boundaries,
   health/telemetry safety, documentation, and package contents.
8. Commit the final tree and create the annotated `v0.2.3` tag with explicit
   authorization, then regenerate provenance from that clean tagged checkout.
9. Run `npm run release:check -- v0.2.3`; it must verify exact archive contents,
   source identity, version uniqueness, the clean commit/tree, and annotated tag
   without repacking.
10. Persist the provenance and versioned schema as non-replaceable GitHub
    Release assets, then publish the verified archive rather than the package
    directory. Publishing remains separately authorization-gated.

## Excluded from Workshop release acceptance

Workshop release acceptance excludes complete Gnolith Site composition,
infrastructure provisioning, Site migration application, host identity and
secrets, deployment configuration, live HTTP/browser/MCP/Codex probes, and final
Site approval. The Codex agent creating the Site owns those checks.
