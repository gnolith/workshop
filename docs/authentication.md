# Authentication and authorization

The host supplies `ResolveWorkshopPrincipal(Request)` and one shared live
`WorkshopAuthorizationSource`. The resolved context is the exact Taproot
authorization shape: installation, principal, active workspace, workspace
memberships, capabilities, and authorization revision. Live installation state
also includes Taproot's search generation. The source must be the same authority
used by Taproot; Workshop does not own a second revision or generation clock.

Every Task and Memory service operation requires the full context. Reads apply
installation and visibility predicates in SQL before content hydration, then
recheck both policy and live authorization state. A revision or membership
change therefore revokes access immediately, including empty-list and cursor
paths. Cursors are host-keyed, domain-separated, and bound to the complete
normalized grant context, query, filters, authorization revision, and search
generation. Every page hydrates and reauthorizes all `limit + 1` rows, including
the metadata-only sentinel, before returning content.

Every Workshop capability is exact. `admin` grants only the administrative
operations that explicitly require `admin`; it does not imply `read`,
`task-write`, `memory-write`, `knowledge-write`, or `search:admin`. Principals
that need more than one operation must carry every corresponding capability.
Exact `search:admin` is required for the host-only legacy authorization
backfill. Legacy rows without complete metadata are quarantined and are not
visible through normal services.

The host provides separate exact Taproot domain guards for Task writes, Memory
writes, Task authorization backfill, Memory authorization backfill, and cursor
snapshot creation. Maintenance and snapshot guards use the shared Taproot fence
without advancing authorization revision, search generation, or an advance ID.
Taproot authorization rejection maps to Workshop's generic `forbidden`; other
database and infrastructure failures remain distinct.

Consumer browser authentication and machine/MCP bearer authentication may use
different host mechanisms but must resolve to the same transport-neutral
authorization shape. UI capability hints are presentation only. Never put access
tokens in tasks or memories.
