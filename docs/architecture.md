# Architecture and domain semantics

Workshop sits above Diamond and Taproot. Diamond owns quads and query internals;
Taproot owns canonical entities, revisions, and RDF projection; Workshop owns
agent-facing tasks, memories, policy adapters, HTTP/MCP, and UI. Workshop routes
knowledge reads only through Taproot's authorized reader. Knowledge mutations
are currently unavailable, and no Workshop path writes RDF directly.

Reads use `AuthorizedTaprootReader` bound to the same live authorization source
that guards Task and Memory operations; raw repositories are not adapter
surfaces. A CI lane packs the exact merged Taproot 0.3 authorization contract
and compiles the public boundary. This is package-runtime compatibility, not
complete-Site assembly or acceptance.

## Tasks

Tasks persist description, advisory role, prompt, context queries, memory slugs,
claim fields, completion/archive timestamps, result, and timestamps. State is
derived in this order: archived, completed, claimed, unclaimed. There is no
status column, claim token, assignment, dependency graph, or ordinary unclaim.

Create and update share a static context-query validator. It rejects update
forms and unsafe constructs without executing a graph query. Updates and
archives prefer `expectedRevision` and retain `expectedUpdatedAt` as a
compatibility token. When both are supplied, revision is authoritative. Claims
and completion use conditional `UPDATE ... RETURNING` statements through the
host's atomic authorization authority, so persistence owns state.

## Packets

A packet is a response, never a row. Every read loads the current task, returns
a bounded fail-closed result for each stored context query, resolves current
authorized memories, rehydrates the owning Task, and records resolution time.
It never claims, executes graph queries, or refreshes in the background.

## Memories

Memories hold reusable methods, procedures, conventions, and checklists. Graph
facts belong in Taproot. Memories are slug-addressed, and every write advances
a monotonic revision. Durable idempotency keys are installation-scoped and
conflict if replayed with different content or visibility.

Historical onboarding schema remains only so existing databases can be opened
and migrated. Onboarding is not a public Workshop service or UI surface in this
release.
