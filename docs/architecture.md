# Architecture and domain semantics

Workshop sits above Diamond and Taproot. Diamond owns quads and query internals;
Taproot owns canonical entities, revisions, RDF projection, and unified-search
materialization; Workshop owns agent-facing tasks, memories, prompts, their
canonical producer adapters, HTTP/MCP, and UI. Workshop routes
knowledge reads only through Taproot's authorized reader. Knowledge mutations
are currently unavailable, and no Workshop path writes RDF directly.

Reads use `AuthorizedTaprootReader` bound to the same live authorization source
that guards Task, Memory, and Prompt operations; raw repositories are not adapter
surfaces. A CI lane packs the exact released Taproot 0.4 producer contract
and compiles the public boundary. This is package-runtime compatibility, not
complete-Site assembly or acceptance.

## Tasks

Tasks persist title/objective, description, constraints, acceptance criteria,
relationships, assignment, language/attribution, advisory role, prompt, context
queries, memory slugs, claim fields, completion/archive timestamps, typed
outcome, and timestamps. State is derived in this order: archived, completed,
claimed, unclaimed. There is no status column, claim token, or ordinary unclaim.

Create and update share a static context-query validator. It rejects update
forms and unsafe constructs without executing a graph query. Updates and
archives prefer `expectedRevision` and retain `expectedUpdatedAt` as a
compatibility token. When both are supplied, revision is authoritative. Claims
and completion use conditional `UPDATE ... RETURNING` statements through the
Taproot's sealed canonical mutation coordinator, so the Workshop row, revision
snapshot, and source event commit atomically.

## Memories and Prompts

Memories include title, applicability, provenance, language, attribution,
policy revision, soft deletion, and immutable history. Prompts are a first-class
canonical domain with ordered/priority metadata, variables, activation state,
visibility policy, soft deletion, and immutable history. Every write requires
the registered search integration and fails closed without it.

## Unified search

`createWorkshopSearchIntegrationV1` initializes Taproot materialization before
registering the Task, Memory, and Prompt producer descriptors. Producers use
bounded enumeration (at most 100), exact revision loads, deterministic
projections, policy-authority authorization, and current-reference hydration.
Legacy adoption and materialization/rebuild/semantic operations are explicit
`search:admin` actions; normal search never performs migration or repair.

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
