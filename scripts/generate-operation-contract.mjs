import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const version = 1;
const routePrefix = '/api/v1/operations';
const read = { readOnly: true, destructive: false, idempotent: true };
const write = { readOnly: false, destructive: false, idempotent: false };
const idempotentWrite = {
  readOnly: false,
  destructive: false,
  idempotent: true,
};
const destructive = {
  readOnly: false,
  destructive: true,
  idempotent: true,
};
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const text = (maxLength = 4096) => ({
  type: 'string',
  minLength: 1,
  maxLength,
});
const positive = { type: 'integer', minimum: 1, maximum: 1_000_000 };
const id = text(256);
const idInput = (field = 'id') => object({ [field]: id }, [field]);
const revisionInput = (field = 'id') =>
  object({ [field]: id, revision: positive }, [field, 'revision']);
const output = object({}, []);
output.additionalProperties = true;

const definitions = [];
function operation(
  name,
  capability,
  annotations,
  inputSchema = object(),
  outputSchema = output,
) {
  definitions.push({
    name,
    version: 1,
    capability,
    annotations,
    route: `${routePrefix}/${name}`,
    inputSchema,
    outputSchema,
  });
}

operation(
  'gnolith_status',
  'read',
  read,
  object(),
  object(
    {
      installationId: id,
      baseIri: text(4096),
      principalId: id,
      credentialId: id,
      activeWorkspaceId: {
        anyOf: [id, { type: 'null' }],
      },
      capabilities: {
        type: 'array',
        maxItems: 256,
        uniqueItems: true,
        items: text(256),
      },
      authorizationRevision: {
        type: 'integer',
        minimum: 0,
        maximum: 1_000_000_000,
      },
      migrationReadiness: object(
        {
          namespace: { const: '@gnolith/workshop' },
          version: positive,
          ready: { type: 'boolean' },
        },
        ['namespace', 'version', 'ready'],
      ),
      compatibility: object(
        {
          diamond: { type: 'boolean' },
          taproot: { type: 'boolean' },
        },
        ['diamond', 'taproot'],
      ),
      canonicalReady: { type: 'boolean' },
      authorizationReady: { type: 'boolean' },
      lexicalReady: { type: 'boolean' },
      semanticState: object(
        {
          state: { enum: ['ready', 'degraded', 'unconfigured'] },
          configured: { type: 'boolean' },
        },
        ['state', 'configured'],
      ),
      producers: object(
        {
          ready: { type: 'boolean' },
          fingerprint: text(256),
          kinds: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            uniqueItems: true,
            items: { enum: ['task', 'memory', 'prompt'] },
          },
        },
        ['ready', 'fingerprint', 'kinds'],
      ),
      blobReady: { type: 'boolean' },
      versions: object(
        {
          server: text(128),
          operationSchema: { const: 1 },
        },
        ['server', 'operationSchema'],
      ),
      operationCatalogDigest: {
        type: 'string',
        pattern: '^[a-f0-9]{64}$',
      },
    },
    [
      'installationId',
      'baseIri',
      'principalId',
      'credentialId',
      'activeWorkspaceId',
      'capabilities',
      'authorizationRevision',
      'migrationReadiness',
      'compatibility',
      'canonicalReady',
      'authorizationReady',
      'lexicalReady',
      'semanticState',
      'producers',
      'blobReady',
      'versions',
      'operationCatalogDigest',
    ],
  ),
);
operation(
  'search',
  'read',
  read,
  object(
    {
      text: text(16_384),
      kinds: {
        type: 'array',
        maxItems: 7,
        uniqueItems: true,
        items: {
          enum: [
            'statement',
            'item',
            'task',
            'memory',
            'prompt',
            'resource',
            'annotation',
          ],
        },
      },
      cursor: text(4096),
      limit: positive,
    },
    ['text'],
  ),
);
operation(
  'search_hydrate',
  'read',
  read,
  object(
    {
      kind: {
        enum: [
          'statement',
          'item',
          'task',
          'memory',
          'prompt',
          'resource',
          'annotation',
        ],
      },
      id,
      revision: positive,
      entityType: { enum: ['item', 'property'] },
    },
    ['kind', 'id', 'revision'],
  ),
);
operation(
  'search_admin',
  'search:admin',
  write,
  object(
    {
      action: {
        enum: [
          'health',
          'materialize',
          'retry-dead',
          'rebuild',
          'activate',
          'semantic-select',
          'semantic-reconnect',
          'semantic-estimate',
          'semantic-approve',
          'semantic-run',
          'semantic-resume',
          'semantic-pause',
          'semantic-stop',
          'semantic-retry',
          'semantic-exclude',
          'semantic-retire',
          'semantic-delete',
        ],
      },
      limit: positive,
      cursor: text(4096),
      options: { type: 'object', additionalProperties: true },
    },
    ['action'],
  ),
);

for (const name of ['get_entity', 'entity_history', 'statement_history'])
  operation(
    name,
    'read',
    read,
    idInput(name === 'statement_history' ? 'statementId' : 'entityId'),
  );
operation(
  'get_entities',
  'read',
  read,
  object(
    {
      entityIds: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        items: id,
      },
    },
    ['entityIds'],
  ),
);
for (const name of ['create_item', 'create_property'])
  operation(
    name,
    'knowledge:write',
    idempotentWrite,
    object(
      {
        idempotencyKey: id,
        authoredText: text(16_384),
        data: { type: 'object', additionalProperties: true },
      },
      ['idempotencyKey', 'authoredText', 'data'],
    ),
  );
operation(
  'mutate_entity',
  'knowledge:write',
  idempotentWrite,
  object(
    {
      entityId: id,
      expectedRevision: positive,
      idempotencyKey: id,
      mutations: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            kind: {
              enum: [
                'label',
                'description',
                'alias',
                'sitelink',
                'statement',
                'rank',
                'qualifier',
                'reference',
              ],
            },
            authoredText: text(16_384),
            value: {},
          },
          required: ['kind', 'authoredText', 'value'],
          additionalProperties: false,
        },
      },
    },
    ['entityId', 'expectedRevision', 'idempotencyKey', 'mutations'],
  ),
);
for (const name of ['entity_revision', 'statement_revision'])
  operation(
    name,
    'read',
    read,
    revisionInput(name === 'statement_revision' ? 'statementId' : 'entityId'),
  );
operation('export_entity_json', 'read', read, idInput('entityId'));

for (const domain of ['resource', 'annotation']) {
  operation(
    `create_${domain}`,
    'knowledge:write',
    idempotentWrite,
    object(
      {
        idempotencyKey: id,
        data: { type: 'object', additionalProperties: true },
      },
      ['idempotencyKey', 'data'],
    ),
  );
  operation(`get_${domain}`, 'read', read, idInput(`${domain}Id`));
  operation(
    `update_${domain}`,
    'knowledge:write',
    idempotentWrite,
    object(
      {
        [`${domain}Id`]: id,
        expectedRevision: positive,
        idempotencyKey: id,
        patch: { type: 'object', additionalProperties: true },
      },
      [`${domain}Id`, 'expectedRevision', 'idempotencyKey', 'patch'],
    ),
  );
  operation(
    `delete_${domain}`,
    'knowledge:write',
    destructive,
    object(
      {
        [`${domain}Id`]: id,
        expectedRevision: positive,
        idempotencyKey: id,
      },
      [`${domain}Id`, 'expectedRevision', 'idempotencyKey'],
    ),
  );
  operation(`${domain}_history`, 'read', read, idInput(`${domain}Id`));
  operation(`${domain}_revision`, 'read', read, revisionInput(`${domain}Id`));
  if (domain === 'resource')
    operation('hydrate_resource', 'read', read, revisionInput('resourceId'));
}

operation(
  'validate_sparql',
  'read',
  read,
  object({ query: text(65_536) }, ['query']),
);
operation(
  'query_sparql',
  'read',
  read,
  object(
    {
      query: text(65_536),
      dryRun: { type: 'boolean' },
      limit: positive,
    },
    ['query'],
  ),
);

operation(
  'list_tasks',
  'read',
  read,
  object({
    cursor: text(4096),
    limit: positive,
    state: { enum: ['unclaimed', 'claimed', 'completed', 'archived'] },
    text: text(4096),
  }),
);
operation(
  'search_tasks',
  'read',
  read,
  object({ text: text(4096), cursor: text(4096), limit: positive }, ['text']),
);
operation('get_task', 'read', read, idInput('taskId'));
operation('get_task_packet', 'read', read, idInput('taskId'));
operation(
  'create_task',
  'task:write',
  idempotentWrite,
  object(
    {
      idempotencyKey: id,
      description: text(4096),
      prompt: text(131_072),
      data: { type: 'object', additionalProperties: true },
    },
    ['idempotencyKey', 'description', 'prompt'],
  ),
);
operation(
  'update_task',
  'task:write',
  idempotentWrite,
  object(
    {
      taskId: id,
      expectedRevision: positive,
      leaseToken: text(4096),
      patch: { type: 'object', additionalProperties: true },
    },
    ['taskId', 'expectedRevision', 'patch'],
  ),
);
operation(
  'archive_task',
  'task:write',
  destructive,
  object({ taskId: id, expectedRevision: positive, leaseToken: text(4096) }, [
    'taskId',
    'expectedRevision',
  ]),
);
operation(
  'claim_task',
  'task:write',
  write,
  object({ taskId: id, leaseSeconds: positive }, ['taskId']),
);
operation(
  'release_task',
  'task:write',
  idempotentWrite,
  object(
    {
      taskId: id,
      leaseToken: text(4096),
      expectedRevision: positive,
      idempotencyKey: id,
    },
    ['taskId', 'leaseToken', 'expectedRevision', 'idempotencyKey'],
  ),
);
operation(
  'complete_task',
  'task:write',
  idempotentWrite,
  object(
    {
      taskId: id,
      leaseToken: text(4096),
      expectedRevision: positive,
      idempotencyKey: id,
      result: text(262_144),
      outcomeKind: { enum: ['success', 'negative', 'inconclusive'] },
    },
    ['taskId', 'leaseToken', 'expectedRevision', 'idempotencyKey', 'result'],
  ),
);
operation(
  'task_history',
  'read',
  read,
  object({ taskId: id, limit: positive }, ['taskId']),
);

operation(
  'list_memories',
  'read',
  read,
  object({ cursor: text(4096), limit: positive, text: text(4096) }),
);
operation('get_memory', 'read', read, idInput('slug'));
operation(
  'upsert_memory',
  'memory:write',
  idempotentWrite,
  object(
    {
      slug: id,
      expectedRevision: positive,
      idempotencyKey: id,
      description: text(4096),
      content: text(131_072),
      data: { type: 'object', additionalProperties: true },
    },
    ['slug', 'idempotencyKey', 'description', 'content'],
  ),
);
operation(
  'delete_memory',
  'memory:write',
  destructive,
  object({ slug: id, expectedRevision: positive, idempotencyKey: id }, [
    'slug',
    'expectedRevision',
    'idempotencyKey',
  ]),
);
operation(
  'memory_history',
  'read',
  read,
  object({ slug: id, limit: positive }, ['slug']),
);

operation(
  'list_prompts',
  'read',
  read,
  object({ cursor: text(4096), limit: positive, text: text(4096) }),
);
operation('get_prompt', 'read', read, idInput('promptId'));
operation(
  'create_prompt',
  'prompt:write',
  idempotentWrite,
  object(
    {
      idempotencyKey: id,
      name: text(256),
      promptText: text(131_072),
      data: { type: 'object', additionalProperties: true },
    },
    ['idempotencyKey', 'name', 'promptText'],
  ),
);
operation(
  'update_prompt',
  'prompt:write',
  idempotentWrite,
  object(
    {
      promptId: id,
      expectedRevision: positive,
      idempotencyKey: id,
      patch: { type: 'object', additionalProperties: true },
    },
    ['promptId', 'expectedRevision', 'idempotencyKey', 'patch'],
  ),
);
operation(
  'delete_prompt',
  'prompt:write',
  destructive,
  object({ promptId: id, expectedRevision: positive, idempotencyKey: id }, [
    'promptId',
    'expectedRevision',
    'idempotencyKey',
  ]),
);
operation(
  'prompt_history',
  'read',
  read,
  object({ promptId: id, limit: positive }, ['promptId']),
);

assert.equal(definitions.length, 51);
assert.equal(new Set(definitions.map(({ name }) => name)).size, 51);

const legacyNames = {
  add_alias: 'mutate_entity',
  add_reference: 'mutate_entity',
  add_sitelink: 'mutate_entity',
  add_statement: 'mutate_entity',
  add_qualifier: 'mutate_entity',
  create_entity: 'create_item or create_property',
  delete_alias: 'mutate_entity',
  delete_reference: 'mutate_entity',
  delete_sitelink: 'mutate_entity',
  delete_statement: 'mutate_entity',
  delete_qualifier: 'mutate_entity',
  dry_run_sparql: 'query_sparql with dryRun=true',
  get_search_status: 'search_admin with action=health',
  query_sparql_update: null,
  reset_abandoned_claim: null,
  search_status: 'gnolith_status or search_admin with action=health',
  set_description: 'mutate_entity',
  set_label: 'mutate_entity',
  set_rank: 'mutate_entity',
};

const catalogBase = {
  format: 'gnolith-operation-catalog-v1',
  operationSchemaVersion: version,
  routePrefix,
  operations: definitions,
};
const canonicalCatalog = canonicalize(catalogBase);
const catalogDigest = createHash('sha256')
  .update(canonicalCatalog)
  .digest('hex');
const catalog = { ...catalogBase, catalogDigest };
const schemaArtifact = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gnolith.dev/schemas/workshop/operations-v1.json',
  title: 'Gnolith Workshop operation catalog',
  ...catalog,
  legacyNames,
};
const operationNames = definitions.map(({ name }) => `'${name}'`).join(' | ');
const ts = `/* Generated by scripts/generate-operation-contract.mjs. Do not edit. */
export const OPERATION_SCHEMA_VERSION = ${version} as const;
export const OPERATION_ROUTE_PREFIX = ${JSON.stringify(routePrefix)} as const;
export const CATALOG_DIGEST = ${JSON.stringify(catalogDigest)} as const;
export const operationCatalog = ${JSON.stringify(definitions, null, 2)} as const;
export type OperationName = ${operationNames};
export type OperationInput<Name extends OperationName> =
  Readonly<Record<string, unknown>> & { readonly __operationName?: Name };
export type OperationOutput<Name extends OperationName> =
  unknown & { readonly __operationName?: Name };
export const legacyOperationNames = ${JSON.stringify(legacyNames, null, 2)} as const;
`;

const outputs = new Map([
  ['src/generated/operations.ts', ts],
  [
    'schemas/gnolith-operations-v1.json',
    `${JSON.stringify(schemaArtifact, null, 2)}\n`,
  ],
  [
    'schemas/legacy-operation-names-v1.json',
    `${JSON.stringify({ format: 'gnolith-legacy-operation-names-v1', names: legacyNames }, null, 2)}\n`,
  ],
]);
const check = process.argv.includes('--check');
for (const [path, contents] of outputs) {
  const absolute = resolve(path);
  if (check) {
    assert.equal(
      readFileSync(absolute, 'utf8'),
      contents,
      `${path} is stale; run npm run generate`,
    );
  } else {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}
console.error(
  `${check ? 'verified' : 'generated'} ${definitions.length} operations (${catalogDigest})`,
);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}
