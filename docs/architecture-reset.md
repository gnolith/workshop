# Workshop 0.5 architecture reset

Workshop is one process with one HTTP listener. `/health/live` is a
dependency-free process probe. `/health/ready`, `/mcp`, and the BFF authenticate
before reading or disclosing protected state. Readiness reports migration,
authorization, canonical data, lexical index, producer, blob, dependency
compatibility, version, and operation-catalog digest state.

Container binds must be explicit, non-loopback, and non-ephemeral. Remote binds
must use an explicit port. Only the test profile permits port zero. Shutdown
stops acceptance, drains requests, aborts and checkpoints bounded background
work, and closes injected dependencies.

`local-bearer-v1` and `remote-oauth-v1` are separate profiles with no fallback.
Local authentication accepts only the Authorization bearer header, compares a
domain-separated digest in constant time, and rechecks the live authorization
fence. OAuth validates signature through an injected verifier and then enforces
issuer, audience, allowed algorithm, time bounds, required scopes, server-owned
scope mappings, and live principal resolution.

Migrations are explicit operator actions. Schema version 7 adds opaque,
expiring task leases, owner and revision fencing, idempotent release receipts,
and lease audit events. Schema version 8 adds durable local credential records
and owner-bound bootstrap receipts. Raw bearer and lease tokens are never
stored.
Backup APIs operate through Workshop owner and migration-ledger handles, report
legacy counts during inspection, and expire imported task leases.

Local resource payloads use
`createLocalFilesystemResourceBlobPortsV1` from
`@gnolith/workshop/backup`. The factory receives one absolute, operator-owned
root and returns Taproot's `ResourceBlobBackupPort` and
`ResourceBlobRestorePort`. Reference IDs stay opaque: neither Seedbed nor an
operator runner derives a path from them. Workshop privately manages the
content-addressed objects, manifest, staging, verification, collision checks,
canonical rebinds, and rollback beneath that root.

The operation registry is generated from one source and validated with Ajv at
the central operation layer. MCP and BFF adapters cannot add operations or
aliases. Search results use exactly seven public kinds: `statement`, `item`,
`task`, `memory`, `prompt`, `resource`, and `annotation`. Property results use
kind `item` with `entityType: "property"`.

Task, Memory, and Prompt mutations cross Taproot's external-producer owner
boundary with one-shot Workshop statement tokens. On update, Workshop reads the
sealed predecessor from the exact registered producer and passes the returned
frozen event identity and sequence unchanged to the next issuer seal. Workshop
does not inspect Taproot search tables or reconstruct predecessor state.

Exact Workshop 0.4.2 owner state is transferred through the public
`@gnolith/workshop/backup` library. `decodeWorkshopLegacyOwnerV042` accepts a
read-only portable database capability plus exact package/schema and
Workshop-namespace ledger attestation. It reads only a fixed Workshop-owned
table allowlist and returns a bounded opaque fragment, SHA-256 evidence, table
counts, and explicit Task/Memory/Prompt/revision contribution counts.
`adoptWorkshopLegacyOwnerV042` passes only a verified fragment to an
owner-bound destination handle; it never mutates the source or reads Seedbed,
Diamond, or Taproot tables.

Optional static content is served only after canonical manifest and per-file
SHA-256 verification. Reserved service prefixes cannot be shadowed.
