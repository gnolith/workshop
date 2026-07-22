# Release artifact provenance

Workshop creates one package archive for local package qualification:

```sh
npm run artifact:prepare
npm run consumer:check
npm run artifact:verify
```

`artifact:prepare` writes an ignored `.release/gnolith-workshop-<version>.tgz`
and adjacent `.provenance.json`. The JSON conforms to
`release-provenance.schema.json` and records:

- package name and version;
- source commit, tree, dirty state, and a worktree-state SHA-256;
- OS, architecture, Node, npm, Git, and `core.autocrlf` values;
- artifact filename, size, SHA-256, npm SHA-1 shasum, SHA-512 integrity, and the
  sorted npm file manifest.

The generic, Worker, and vinext consumers install that existing archive. They do
not repack the working directory. `artifact:verify` parses the retained archive,
validates the provenance against the JSON Schema, compares the actual tar
manifest, validates every export target, and checks packed migration bytes and
checksums against the packed compiled manifest.

`release:check` is stricter than local verification. It requires a clean source
state, provenance commit/tree equal to the current `HEAD`, and an existing
annotated version tag that resolves to that commit. It is expected to fail in an
uncommitted review tree. An annotated version-tag push runs the trusted workflow,
publishes the same verified `.tgz` through npm OIDC, and revalidates its exact
registry provenance. Only after those checks succeed does the workflow create
the immutable GitHub Release with the provenance and versioned schema assets.
A manually pre-created Release is rejected rather than used as a trigger.

The version-history check compares package-producing inputs with every reachable
commit that declared the same version. Material package changes require a new
version or prerelease identifier. A dirty local verification is recorded as
such. After the final commit and annotated tag exist, regenerate the artifact so
release provenance names the clean tagged commit before publishing.
