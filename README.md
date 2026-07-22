# Workshop

`@gnolith/workshop` is Gnolith's agent-facing operating layer: durable research
tasks, ephemeral task packets, reusable memories, authorization-aware graph access,
Taproot-backed knowledge tools, Streamable HTTP MCP, Worker route factories,
and the Workshop Waystone UI.

One Codex Site is one research project. Workshop operates inside that Site-wide
graph and task system; it does not add projects, memberships, agent sessions,
packet snapshots, or a background coordinator.

## Runtime surfaces

| Import                         | Runtime        | Purpose                                               |
| ------------------------------ | -------------- | ----------------------------------------------------- |
| `@gnolith/workshop`            | any            | Package identity and safe shared types                |
| `@gnolith/workshop/core`       | any            | Process-local services and authorized tool dispatch   |
| `@gnolith/workshop/protocol`   | browser/Worker | Models, errors, and injectable HTTP client            |
| `@gnolith/workshop/server`     | Worker/process | Persistence services, health, and HTTP adapters       |
| `@gnolith/workshop/mcp`        | any/Worker     | Neutral tool dispatcher and stateless HTTP MCP server |
| `@gnolith/workshop/site`       | Worker         | Thin App Router-compatible route factories            |
| `@gnolith/workshop/ui`         | browser        | React 19 components and `workshopPlugin`              |
| `@gnolith/workshop/migrations` | installer      | Embedded canonical migration manifest                 |
| `@gnolith/workshop/styles.css` | browser        | Workshop-specific styles                              |

The root export intentionally does not import all runtimes.

## Process-local integration

Core services run directly in a process without HTTP, a UI, or a listening
server. The host injects one structural SQLite persistence capability, the same
live atomic authorization authority used by Taproot, an opaque cursor codec,
and read-authorized knowledge/health adapters:

```ts
import { createWorkshopCore } from '@gnolith/workshop/core';

const workshop = createWorkshopCore({
  persistence,
  authorization,
  cursorCodec,
  knowledge: { authorizedReader, health: taprootHealth },
  diamondHealth,
});
```

Workshop owns its exact migrations and service behavior. Seedbed owns database
paths, adapter lifecycle, stdio/CLI wiring, Docker, and package assembly.

## Install

```sh
npm install @gnolith/workshop @gnolith/diamond @gnolith/taproot react
```

Workshop targets Node.js 22+ for development and Web API runtimes. Its published
package is checked in isolated Worker and vinext consumers without the Workers
Node compatibility flag. Those consumers inject or stub peer services and do
not represent a complete Gnolith Site.

## Site integration

Create the runtime once from host-provided D1, identity, Diamond, and Taproot
services. Authentication belongs to the Site; role labels on tasks never grant
permissions.

```ts
import { createWorkshopRuntime } from '@gnolith/workshop/server';

export const workshop = createWorkshopRuntime({
  db: env.DB,
  authorization: siteAuthorization,
  cursorCodec: siteCursorCodec,
  knowledge: {
    authorizedReader: createAuthorizedReader,
    health: taprootHealth,
  },
  diamondHealth: siteDiamond.health,
  resolvePrincipal: authenticateWorkshopRequest,
});
```

`siteAuthorization` is the single shared live source and mutation authority. Its
separate Task, Memory, authorization-backfill, and cursor-snapshot methods must
use Taproot's host-issued guards bound to exact `task-write`, `memory-write`,
`search:admin`, or `read` capabilities, verify the current authorization and
search-generation state, and execute the Workshop statements in the same host
transaction/batch. They must never add or translate capabilities.
`createAuthorizedReader` must return the public `AuthorizedTaprootReader` bound
to that same source. Knowledge mutations are unavailable until that shared
foundation is complete.

Generated App Router files stay thin:

```ts
import { createWorkshopMcpHandler } from '@gnolith/workshop/site';
import { workshop } from '@/lib/gnolith/server';

const handler = createWorkshopMcpHandler(workshop);
export const GET = handler;
export const POST = handler;
```

Consumers apply migrations explicitly before constructing the runtime. Runtime
construction never creates tables. `workshopMigrations` provides canonical SQL
and checksums; `applyWorkshopMigrations(persistence)` applies only
Workshop-owned schema through Diamond's shared namespaced checksum ledger when
the host chooses to initialize or migrate.

## Core behavior

- Task creation validates every field, statically rejects SPARQL writes and
  unsafe query forms, and verifies all memory references before inserting.
- `claim_task` is one conditional SQLite update. Concurrent callers cannot both win.
- Completion is one conditional update and accepts negative or inconclusive
  nonempty results.
- Task packets resolve authorized current memories on every read. Unscoped
  context-query execution is disabled until the host supplies a scoped graph
  boundary. Packet reads do not claim or mutate tasks.
- Knowledge reads use Taproot's authorized-reader boundary. Mutations are
  fail-closed and are not advertised by Workshop's MCP surface.
- MCP authenticates every request and authorizes every tool server-side.
- Detailed diagnostics require exact `admin`; abandoned-claim reset requires
  exact `admin` plus `task-write`. Capabilities never imply one another. These
  operations are not normal MCP tools.

## Development

```sh
npm ci
npm run check
```

The gate covers formatting, lint, strict types, coverage, local D1 integration
and concurrency, MCP, routes, interactive UI, build, performance, generic
exact-tarball validation, isolated Worker and vinext package consumers, audit,
readiness, and release-artifact invariants. One generated tarball and its
machine-verifiable provenance are reused by every package consumer and release
check. Peer services in the runtime consumers are injected or stubbed. See
[`docs/release-provenance.md`](docs/release-provenance.md).

Configure the Waystone contribution with a browser-only client. Construction is
lazy, so importing the UI never initializes a server runtime or captures host
bindings:

```tsx
import { createWorkshopClient } from '@gnolith/workshop/protocol';
import { createWorkshopPlugin } from '@gnolith/workshop/ui';

export const workshopUi = createWorkshopPlugin({
  client: () =>
    createWorkshopClient({
      baseUrl: '',
      token: () => sessionToken(),
    }),
  capabilities: currentCapabilities,
  loadMcpStatus: loadWorkshopMcpStatus,
});
```

Legacy onboarding journals remain quarantined and are not exposed by the
public core, protocol, MCP, HTTP, or UI surfaces. A separately scoped reusable
exploration skill will own future onboarding behavior.

`Workshop package handoff ready` means these package-owned gates pass against
the exact tarball. It does not qualify a complete Gnolith Site. The Codex agent
creating a Site owns four-package assembly, infrastructure and migrations,
identity and secrets, deployment configuration, live browser/MCP/Codex probes,
and final acceptance.

## Documentation

- [Architecture and domain semantics](docs/architecture.md)
- [HTTP and client API](docs/http-api.md)
- [MCP tools](docs/mcp.md)
- [Authentication and authorization](docs/authentication.md)
- [Migrations and upgrades](docs/migrations.md)
- [Authorization foundation ledger](docs/authorization-foundation.md)
- [Waystone UI](docs/ui-and-onboarding.md)
- [Health and semantic verification](docs/verification.md)
- [Operational limits](docs/limits.md)
- [Security and threat assumptions](docs/security.md)
- [Codex Sites compatibility](docs/codex-sites.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist and current evidence](docs/release-checklist.md)
- [Package handoff contract](docs/package-handoff.md)

## License

MIT
