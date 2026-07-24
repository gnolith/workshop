# @gnolith/workshop

Workshop 0.5 is the self-hosted Gnolith executable. It owns one HTTP listener,
the authenticated `/mcp` endpoint, authenticated `/health/ready`, live
`/health/live`, and the `/api/v1/operations/*` BFF.

The release is intentionally headless. The former React UI, Site route
factories, Worker runtime, stdio transport, and hand-written parallel tool
catalog are not part of 0.5.

## Executable

```sh
gnolith-workshop serve --config /run/gnolith/workshop.json
```

The JSON config uses format `gnolith-workshop-config-v1`, selects exactly one
authentication profile (`local-bearer-v1` or `remote-oauth-v1`), declares an
explicit listener profile, and points to an adapter module that supplies the
Diamond and Taproot public ports. Startup is fail-closed: it does not apply
migrations or bootstrap authorization.

Offline first-owner bootstrap never opens a socket:

```sh
gnolith-workshop bootstrap-v1 \
  --config /run/gnolith/workshop.json \
  --installation-id installation:example \
  --base-iri https://example.invalid/ \
  --principal principal:owner \
  --workspace workspace:default \
  --credential-file /run/secrets/workshop-token \
  --idempotency-key initial-owner-v1
```

The local bearer credential file must contain exactly 32 random bytes encoded
as unpadded base64url, optionally followed by one LF. The token is never a
command argument and only its domain-separated digest is persisted.
Bootstrap requires Workshop schema version 8 and commits that credential digest
plus an owner receipt through Taproot's sealed owner-adapter API.

Local resource payload backup and restore use the public server-only factory:

```ts
import { createLocalFilesystemResourceBlobPortsV1 } from '@gnolith/workshop/backup';

const blobs = await createLocalFilesystemResourceBlobPortsV1({
  root: '/var/lib/gnolith/blobs',
});
```

The returned `backup` and `restore` ports accept only Taproot descriptors,
streams, stage IDs, and opaque reference IDs. Filesystem layout remains private
to Workshop.

## Protocol

The sole MCP identity is `gnolith`. The generated operation contract contains
exactly 51 version-1 operations and is checked into
`schemas/gnolith-operations-v1.json`. The same generated registry drives MCP,
the BFF, runtime validation, and the generic browser-safe client:

```ts
import { createWorkshopClient } from '@gnolith/workshop/client';

const client = createWorkshopClient({
  baseOrigin: 'https://gnolith.example',
  accessToken: async () => obtainAccessToken(),
});
const status = await client.call('gnolith_status', {});
```

See [the architecture-reset guide](docs/architecture-reset.md) for deployment,
authentication, migration, lease, backup, and compatibility details.
