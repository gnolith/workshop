# npm release authentication

Workshop publishes only through npm trusted publishing from
`.github/workflows/release.yml` in the protected `npm` environment. The fresh
publish job receives `id-token: write` and npm exchanges that GitHub OIDC
identity directly; no npm access token, bootstrap secret, or `NODE_AUTH_TOKEN`
fallback is permitted.

Release recovery remains tokenless with respect to npm: an existing version is
accepted only after its registry tarball hashes and npm provenance identity
match the verified build outputs. A missing version reaches the single
OIDC-backed `npm publish` step.
