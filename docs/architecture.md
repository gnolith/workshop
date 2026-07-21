# Architecture and domain semantics

Workshop sits above Diamond and Taproot. Diamond owns quads and query internals;
Taproot owns canonical entities, revisions, and RDF projection; Workshop owns
agent-facing tasks, memories, policy adapters, HTTP/MCP, and UI. Knowledge writes
flow only through the injected `KnowledgeService`, normally created with
`createTaprootKnowledgeService`. No Workshop path writes RDF directly.

## Tasks

Tasks persist description, advisory role, prompt, context queries, memory slugs,
claim fields, completion/archive timestamps, result, and timestamps. State is
derived in this order: archived, completed, claimed, unclaimed. There is no
status column, claim token, assignment, dependency graph, or ordinary unclaim.

Create and update share the same SPARQL validation service used by direct tools.
Updates and archives require `expectedUpdatedAt`; Taproot edits require
`expectedRevision`.
Claims and completion use conditional `UPDATE ... RETURNING` statements so D1,
not process memory or an MCP session, owns state.

## Packets

A packet is a response, never a row. Every read loads the current task, executes
the current graph queries under limits, captures per-query result or structured
error, resolves current memories, and records resolution time. It never claims
or refreshes in the background.

## Memories

Memories hold reusable methods, procedures, conventions, and checklists. Graph
facts belong in Taproot. Memories are slug-addressed and deliberately have no
version table in 0.1.

## Onboarding

Onboarding plans ordinary Items, memories, and a small reviewable task set. It
requires an explicit idempotency key, creates no project object, and never
launches agents. Hosts should show `OnboardingSeedPlan` before calling `apply`.
Task creation carries deterministic seed keys. Hosts can require the explicit
expected-empty precondition, and a transaction-composable Taproot/D1 adapter can
provide `OnboardingServiceOptions.transaction` so a failed apply rolls back as
one operation.
