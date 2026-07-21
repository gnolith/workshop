# Authentication and authorization

The host supplies `ResolveWorkshopPrincipal(Request)`. A principal has an ID and
explicit capabilities: `read`, `task-write`, `knowledge-write`, `memory-write`,
or `admin`. Admin implies other capabilities. Task role labels are advisory and
never consulted for authorization.

Every mutation checks authorization in the route or MCP adapter before reaching
the service. Detailed diagnostics, semantic probes, claimed-task administrative
archive, and abandoned-claim reset require admin. MCP rejects anonymous clients;
public deployments therefore expose no anonymous writes by default.

Site-owner browser authentication and machine/MCP bearer authentication may use
different host mechanisms but must resolve to the same transport-neutral
principal shape. UI capability hints are presentation only. Never put access
tokens in tasks or memories.
