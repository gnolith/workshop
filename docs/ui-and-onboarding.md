# Waystone UI

Use `createWorkshopPlugin(options)` and register its result through Waystone's
public structural plugin contract. Import `@gnolith/workshop/styles.css` once
in the consumer shell. The default `workshopPlugin` uses a same-origin,
read-only client; hosts normally inject a client factory and the current
capability set. Workshop does not import Waystone internals, server code, or D1
from browser code.

The plugin contributes Tasks and Memories navigation, routes, a dashboard,
related-task entity panel, and admin MCP status. Route components load and
filter tasks and memories, create and edit them, compile packet views, and claim
or complete tasks. Loading, denied permissions, request failures, and revision
conflicts are explicit. The client and status loader are host-injected browser
contracts; no UI module constructs a Workshop server runtime.

```tsx
const plugin = createWorkshopPlugin({
  client: () => createWorkshopClient({ token: getSessionToken }),
  capabilities,
  loadMcpStatus: () => statusApi.workshopMcp(),
});
```

Exported components cover lists, filters, cards, state badges, detail, packets,
query-result status, claim/completion controls, editors, and MCP status.
Content is rendered as text, actions use semantic controls, permission/conflict
errors are explicit, and layouts are responsive.

Onboarding is intentionally absent from the public plugin, protocol, core,
HTTP, and MCP surfaces. Historical journal tables remain migration artifacts
only. Future repeatable research exploration belongs in the separately scoped
agent-skill work, after the shared Taproot authorization foundation is complete.
