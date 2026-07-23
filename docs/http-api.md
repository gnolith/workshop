# HTTP route factories and browser client

`@gnolith/workshop/site` exports:

- `createTasksHandler`, `createTaskHandler`, `createTaskPacketHandler`
- `createTaskClaimHandler`, `createTaskCompleteHandler`, `createTaskHistoryHandler`
- `createMemoriesHandler`, `createMemoryHandler`, `createMemoryHistoryHandler`
- `createPromptsHandler`, `createPromptHandler`, `createPromptHistoryHandler`
- `createSearchHandler`, `createSearchAdminHandler`, `createSearchStatusHandler`
- `createSparqlValidationHandler`, `createSparqlDryRunHandler`,
  `createSparqlQueryHandler`
- `createWorkshopMcpHandler`, `createWorkshopHealthHandler`,
  `createWorkshopProbeHandler`

Handlers accept Web `Request` and return Web `Response`, making them suitable for
thin host-framework shims. JSON routes are same-origin by default,
enforce request limits and capabilities, return `{ error: WorkshopErrorBody }`,
and never expose stacks. Health is safe and public. Probe diagnostics (`GET`)
require exact `admin`; the mutating semantic probe (`POST`) requires exact
`admin`, `task-write`, and `memory-write`.
Task archival is revision-conditional: HTTP clients send the task's exact
`revision` value in `X-Workshop-Revision` (preferred) or the legacy exact
`updatedAt` value in `If-Match`. Completed tasks are terminal and cannot later
be archived; the semantic probe uses a separate disposable archive task.

`createWorkshopClient` from `/protocol` defaults to same-origin
`/api/workshop/*`. It supports a base URL, injectable `fetch`, asynchronous token
callback, `AbortSignal`, and typed `WorkshopError`. It imports no server module
and accesses no browser global until the client is constructed. The typed
`tasks.archive(id, revisionOrUpdatedAt)` supplies the matching revision header
automatically.

`tasks.history(id, { limit })`, `memories.history(slug, { limit })`, and
`prompts.history(id, { limit })` are required public client operations. Their
GET routes accept the same optional positive `limit` query parameter, bounded
by Workshop's configured maximum page size, and return newest-first revision
arrays with live authorization rechecked immediately before response creation.
