# Waystone UI and onboarding

Use `createWorkshopPlugin(options)` and register its result through Waystone's
public structural plugin contract. Import `@gnolith/workshop/styles.css` once
in the consumer shell. The default `workshopPlugin` uses a same-origin, read-only
client; hosts normally inject a client factory and the current
capability set. Workshop does not import Waystone internals, server code, or D1
from browser code.

The plugin contributes Tasks and Memories navigation, routes, a dashboard,
related-task entity panel, research-seeding onboarding, and admin MCP status.
The route components load and filter tasks and memories, create and edit them,
compile packet views, claim and complete tasks, preview/apply onboarding, and
show host-supplied MCP status. Loading, read-only/denied permissions, request
failures, and revision conflicts are explicit. The client, onboarding
controller, and status loader are host-injected browser contracts; no UI module
constructs a Workshop server runtime.

```tsx
const plugin = createWorkshopPlugin({
  client: () => createWorkshopClient({ token: getSessionToken }),
  capabilities,
  onboarding: {
    preview: (input) => onboardingApi.preview(input),
    apply: (plan) => onboardingApi.apply(plan),
  },
  loadMcpStatus: () => statusApi.workshopMcp(),
});
```

Exported components also cover lists, filters, cards, state badges, detail,
packets, query results, claim/completion controls, editors, onboarding, and MCP
status.
Status includes text/symbols, content is rendered as text, actions use semantic
controls, permission/conflict errors are explicit, and layouts are responsive.

Onboarding gathers language, topics, terms, people, places, objects, sources,
existing research, scope boundaries, and reusable guidance. `plan` returns the
small proposed seed; only an explicit `apply` writes ordinary Taproot Items,
memories, and tasks. It creates no project, ontology explosion, or agents.
`apply` accepts an explicit `expectedEmpty` precondition through the host's
`isEmpty` adapter. When all writers can participate in a shared transaction,
the host supplies `OnboardingServiceOptions.transaction`; Workshop runs the
entire apply operation inside it and propagates rollback failures.
