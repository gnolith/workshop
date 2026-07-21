# Isolated package-runtime canary

This fixture verifies that the exact published Workshop package bundles in a
supported Worker runtime. It is invoked only through Wrangler's local
`deploy --dry-run` output and Miniflare.

Diamond, Taproot, identity, and host services are injected or stubbed. The D1
identifier is intentionally invalid. This directory does not assemble,
provision, deploy, or accept a complete Gnolith Site, and it is not included in
the Workshop npm package.

The Codex agent creating a Site owns deployable host assets, four-package
composition, infrastructure, live probes, and final acceptance.
