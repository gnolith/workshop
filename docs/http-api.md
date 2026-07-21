# HTTP route factories and browser client

`@gnolith/workshop/site` exports:

- `createTasksHandler`, `createTaskHandler`, `createTaskPacketHandler`
- `createTaskClaimHandler`, `createTaskCompleteHandler`
- `createMemoriesHandler`, `createMemoryHandler`
- `createSparqlValidationHandler`, `createSparqlDryRunHandler`,
  `createSparqlQueryHandler`
- `createWorkshopMcpHandler`, `createWorkshopHealthHandler`,
  `createWorkshopProbeHandler`

Handlers accept Web `Request` and return Web `Response`, making them suitable for
thin host-framework shims. JSON routes are same-origin by default,
enforce request limits and capabilities, return `{ error: WorkshopErrorBody }`,
and never expose stacks. Health is safe and public; probe/diagnostics are admin.
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
