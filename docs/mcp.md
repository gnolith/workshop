# MCP tool reference

`createWorkshopMcpServer` implements stateless Streamable HTTP for MCP
`2025-11-25` and returns JSON responses. POST clients must accept
`application/json` and `text/event-stream`; GET returns 405 because Workshop does
not open a server-notification SSE stream. No task state lives in transport
sessions.

## Tasks

`list_tasks`, `search_tasks`, `get_task_packet`, `create_task`, `update_task`,
`archive_task`, `claim_task`, `complete_task`.

`update_task` and `archive_task` require `expectedRevision` (preferred) or the
legacy exact current `expectedUpdatedAt`
timestamp. This makes concurrent complete/archive transitions deterministic.

## Memories

`list_memories`, `get_memory`, `upsert_memory`.

## SPARQL

`validate_sparql`, `dry_run_sparql`, `query_sparql`. Normal access is read-only;
updates, LOAD, and unapproved SERVICE targets are rejected.

## Knowledge

`search_entities`, `get_entity`, `get_entities`, `create_item`,
`create_property`, `set_label`, `set_description`, `add_alias`, `remove_alias`,
`add_sitelink`, `remove_sitelink`, `add_statement`, `replace_statement`,
`remove_statement`, `set_statement_rank`, `add_qualifier`, `remove_qualifier`,
`add_reference`, `remove_reference`, `export_entity_json`.

Knowledge mutations require the exact current `expectedRevision`. Results come
from Taproot and include entity/revision metadata. `tools/list` is deterministic
and capability-filtered. Domain failures are `isError` tool results so agents
can correct inputs. Unknown tools remain JSON-RPC errors. Administrative claim
reset is intentionally absent.
