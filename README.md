# Workshop

**Hosted agent tasks, memories, coordination, and tooling.**

Workshop will provide the hosted execution and coordination layer for agents
working with Gnolith sites.

## Status

This repository is a private, non-publishable scaffold. It deliberately exposes
no public API yet.

## Intended boundaries

- Own task lifecycle, durable memory, coordination, and hosted tool contracts.
- Consume public knowledge and storage interfaces without owning their schemas.
- Keep local MCP connectivity in [`@gnolith/waystone`](https://github.com/gnolith/waystone).
- Avoid dependencies from lower-level packages back into Workshop.

## Development

```sh
npm ci
npm run check
```

## License

MIT
