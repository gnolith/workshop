# MCP tool reference

`createWorkshopMcpServer` implements stateless Streamable HTTP for MCP
`2025-11-25` and returns JSON responses. POST clients must accept
`application/json` and `text/event-stream`; GET returns 405 because Workshop does
not open a server-notification SSE stream. No task state lives in transport
sessions.

## Tasks

`list_tasks`, `search_tasks`, `get_task_packet`, `create_task`, `update_task`,
`archive_task`, `claim_task`, `complete_task`, `task_history`.

`update_task` and `archive_task` require `expectedRevision` (preferred) or the
legacy exact current `expectedUpdatedAt`
timestamp. This makes concurrent complete/archive transitions deterministic.

`task_history` requires exact `read`, accepts an optional bounded `limit`, and
returns newest-first canonical revisions only after authorizing every snapshot
and rechecking the exact current Task and live authorization state.

## Memories

`list_memories`, `get_memory`, `upsert_memory`, `delete_memory`,
`memory_history`.

`memory_history` has the same bounded newest-first, per-snapshot authorization,
canonical-identity, and final current-record recheck guarantees as Task history.

## Prompts and unified search

`list_prompts`, `get_prompt`, `create_prompt`, `update_prompt`, `delete_prompt`,
`prompt_history`, `search`, `search_status`, `search_admin`.

`prompt_history` uses the same hardened history read boundary.

Prompt, Memory, and Task writes are sealed atomically with their canonical
Taproot source events. `search` uses Taproot's authorization-aware result and
hydration boundary. `search_admin` dispatches bounded legacy adoption,
materialization/rebuild/retry, and semantic lifecycle actions; it requires
`search:admin`. Semantic provider and vector-port configuration is a host API
because runtime secrets and capability objects are not JSON tools.

## Knowledge

`search_entities`, `get_entity`, `get_entities`, `export_entity_json`.

Results come from Taproot's `AuthorizedTaprootReader` and include
entity/revision metadata. Knowledge mutations and SPARQL execution are not
registered or advertised; direct mutation calls fail closed. `tools/list` is
deterministic and capability-filtered. Domain failures are `isError` tool
results so agents can correct inputs. Unknown tools remain JSON-RPC errors.
Administrative claim reset is intentionally absent.

Task context queries remain stored, statically validated metadata. Packet
hydration returns a bounded per-query forbidden result instead of executing
them until a scoped Diamond boundary exists.
