# Release checklist

## Workshop package handoff

1. Confirm the version, peer ranges, changelog, license, and public exports.
2. Run `npm ci && npm run check` on supported Node releases.
3. Verify migration order, checksums, clean application, and upgrade behavior.
4. Inspect the tarball and install that exact artifact in generic, Worker, and
   vinext App Router consumers.
5. Confirm the Workshop Worker canary needs no Node compatibility flags.
6. Audit MCP tool descriptions/schemas, browser/server dependency boundaries,
   health/telemetry safety, documentation, and package contents.
7. Run `npm run release:check -- v0.1.0`.
8. Publish, tag, push, or deploy only with explicit authorization.

## Downstream Site production verification

The Site integration team owns managed bindings/migrations, full package
composition, deployed HTTP/browser/MCP probes, real Taproot/Diamond projection,
and the intended Codex connection. These checks qualify the complete Site, not
the Workshop package handoff. See `package-handoff.md` and
`release-evidence.md`.
