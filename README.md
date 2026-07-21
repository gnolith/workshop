# Workshop

`@gnolith/workshop` is Gnolith's agent-facing operating layer: durable research
tasks, ephemeral task packets, reusable memories, bounded SPARQL access,
Taproot-backed knowledge tools, Streamable HTTP MCP, Worker route factories,
and the Workshop Waystone UI.

One Codex Site is one research project. Workshop operates inside that Site-wide
graph and task system; it does not add projects, memberships, agent sessions,
packet snapshots, or a background coordinator.

## Runtime surfaces

| Import                         | Runtime        | Purpose                                                  |
| ------------------------------ | -------------- | -------------------------------------------------------- |
| `@gnolith/workshop`            | any            | Package identity and safe shared types                   |
| `@gnolith/workshop/protocol`   | browser/Worker | Models, errors, and injectable HTTP client               |
| `@gnolith/workshop/server`     | Worker         | D1 services, SPARQL/Taproot adapters, health, onboarding |
| `@gnolith/workshop/mcp`        | Worker         | MCP tool schemas and stateless server                    |
| `@gnolith/workshop/site`       | Worker         | Thin App Router-compatible route factories               |
| `@gnolith/workshop/ui`         | browser        | React 19 components and `workshopPlugin`                 |
| `@gnolith/workshop/migrations` | installer      | Embedded canonical migration manifest                    |
| `@gnolith/workshop/styles.css` | browser        | Workshop-specific styles                                 |

The root export intentionally does not import all runtimes.

## Install

```sh
npm install @gnolith/workshop @gnolith/diamond @gnolith/taproot react
```

Workshop targets Node.js 22+ for development and Cloudflare Workers in
production. It uses Web APIs and does not require the Workers Node compatibility
flag.

## Site integration

Create the runtime once from host-provided D1, identity, Diamond, and Taproot
services. Authentication belongs to the Site; role labels on tasks never grant
permissions.

```ts
import { createTaproot } from '@gnolith/taproot';
import {
  createTaprootKnowledgeService,
  createWorkshopRuntime,
} from '@gnolith/workshop/server';

const taproot = createTaproot(env.DB, { baseIri: 'https://research.example' });

export const workshop = createWorkshopRuntime({
  db: env.DB,
  executeSparql: siteDiamond.query,
  knowledge: createTaprootKnowledgeService(taproot),
  resolvePrincipal: authenticateWorkshopRequest,
});
```

Generated App Router files stay thin:

```ts
import { createWorkshopMcpHandler } from '@gnolith/workshop/site';
import { workshop } from '@/lib/gnolith/server';

const handler = createWorkshopMcpHandler(workshop);
export const GET = handler;
export const POST = handler;
```

Apply migrations during installation/deployment. Runtime construction never
creates tables. The installer reads `workshopMigrations`, verifies checksums,
and materializes SQL into the Site's committed `drizzle/` directory.

## Core behavior

- Task creation validates every field, rejects SPARQL writes, dry-runs every
  context query, and verifies all memory references before inserting anything.
- `claim_task` is one conditional D1 update. Concurrent callers cannot both win.
- Completion is one conditional update and accepts negative or inconclusive
  nonempty results.
- Task packets execute current context queries and resolve current memories on
  every read. Packet reads do not claim or mutate tasks.
- Knowledge mutations delegate to Taproot and require expected revisions.
- MCP authenticates every request and authorizes every tool server-side.
- Detailed diagnostics and abandoned-claim reset remain administrative server
  capabilities and are not normal MCP tools.

## Development

```sh
npm ci
npm run check
```

The gate covers formatting, lint, strict types, coverage, D1 integration and
concurrency, MCP, routes, interactive UI, build, performance, a no-compat
Workshop Worker, exact-tarball Worker and vinext consumers, audit, readiness,
and release-artifact invariants.

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
  onboarding: onboardingHttpController,
  loadMcpStatus: loadWorkshopMcpStatus,
});
```

`Workshop package handoff ready` means these package-owned gates pass against
the exact tarball. It does not mean a full Gnolith/Codex Site has been deployed
or verified. Managed D1/R2 provisioning, full Site composition, browser/live
MCP probes, and Codex environment verification belong to downstream Site
integration.

## Documentation

- [Architecture and domain semantics](docs/architecture.md)
- [HTTP and client API](docs/http-api.md)
- [MCP tools](docs/mcp.md)
- [Authentication and authorization](docs/authentication.md)
- [Migrations and upgrades](docs/migrations.md)
- [Waystone UI and onboarding](docs/ui-and-onboarding.md)
- [Health and semantic verification](docs/verification.md)
- [Operational limits](docs/limits.md)
- [Security and threat assumptions](docs/security.md)
- [Codex Sites compatibility](docs/codex-sites.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist and current evidence](docs/release-checklist.md)
- [Package handoff contract](docs/package-handoff.md)

## License

MIT
