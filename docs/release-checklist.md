# Release checklist

> **Publication is package-gated.** `release:check` and normal `npm publish`
> require public, provenance-verified `@gnolith/taproot` 0.4.0 plus Workshop's
> clean, tagged, version-consistent artifact provenance. Complete-Site
> acceptance is neither a prerequisite nor evidence for a Workshop release.

## Workshop package handoff

1. Confirm the version, peer ranges, changelog, license, and public exports.
2. Run `npm ci && npm run check` on supported Node releases.
   This is the package-owned full gate, including security, native SQLite,
   persisted D1, and exact packed-peer conformance.
3. Verify migration order, checksums, clean application, and upgrade behavior.
4. Run `npm run artifact:prepare` once; retain its generated commit, environment,
   SHA-256, npm integrity, and file-manifest provenance.
5. Install that existing artifact in generic and isolated Worker/vinext
   consumers with injected or stubbed peers, then run `artifact:verify`.
6. Confirm the isolated Workshop package consumer needs no undeclared runtime
   compatibility flags.
7. Audit MCP tool descriptions/schemas, browser/server dependency boundaries,
   health/telemetry safety, documentation, and package contents.
8. Commit the final tree and create the annotated `v0.4.1` tag with explicit
   authorization, then regenerate provenance from that clean tagged checkout.
9. Run `npm run release:check -- v0.4.1`; it must verify exact archive contents,
   source identity, version uniqueness, the clean commit/tree, and annotated tag
   without repacking. Normal `npm publish` derives this tag from the package
   version and runs both the Taproot provenance gate and the same Workshop
   release check before publication.
10. Push the annotated tag. The tag-driven OIDC workflow must repeat package
    verification, publish the verified archive rather than the package
    directory, verify exact npm provenance, and only then create the immutable
    GitHub Release with provenance assets. Do not create the Release manually.

## Excluded from Workshop release acceptance

Workshop release acceptance excludes complete Gnolith Site composition,
infrastructure provisioning, Site migration application, host identity and
secrets, deployment configuration, live HTTP/browser/MCP/Codex probes, and final
Site approval. The Codex agent creating the Site owns those checks.
Package CI must not provision, deploy, assemble, or accept a complete Site.
