import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const version = 2;
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
          revision: {
            anyOf: [positive, { type: 'null' }],
          },
          fingerprint: {
            anyOf: [
              { type: 'string', pattern: '^[a-f0-9]{64}$' },
              { type: 'null' },
            ],
          },
          ready: { type: 'boolean' },
        },
        ['state', 'configured', 'revision', 'fingerprint', 'ready'],
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
          operationSchema: { const: version },
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
const policyRevision = {
  type: 'integer',
  minimum: 1,
  maximum: 1_000_000_000,
};
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const localBearerTokenDigest = {
  ...digest,
  description:
    'Lowercase hexadecimal SHA-256 of UTF-8 "gnolith-local-bearer-v1\\u0000" followed by the 32 bytes obtained by base64url-decoding the exact 43-character bearer token.',
};
const visibilityAtom = {
  oneOf: [
    object({ kind: { const: 'public' } }, ['kind']),
    object({ kind: { const: 'principal' }, principalId: id }, [
      'kind',
      'principalId',
    ]),
    object({ kind: { const: 'workspace' }, workspaceId: id }, [
      'kind',
      'workspaceId',
    ]),
    object({ kind: { const: 'capability' }, capability: text(256) }, [
      'kind',
      'capability',
    ]),
  ],
};
const visibilityScope = object(
  {
    version: { const: 1 },
    clauses: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: visibilityAtom,
      },
    },
  },
  ['version', 'clauses'],
);
const policyTarget = object(
  {
    kind: { enum: ['entity', 'resource', 'annotation'] },
    id,
  },
  ['kind', 'id'],
);
const authorizationMutation = (action, properties, required) =>
  object(
    {
      version: { const: 1 },
      action: { const: action },
      expectedPolicyRevision: policyRevision,
      idempotencyKey: id,
      ...properties,
    },
    [
      'version',
      'action',
      'expectedPolicyRevision',
      'idempotencyKey',
      ...required,
    ],
  );
operation(
  'authorization_admin',
  'admin',
  idempotentWrite,
  {
    oneOf: [
      authorizationMutation(
        'principal-create',
        {
          principal: object(
            {
              principalId: id,
              enabled: { type: 'boolean' },
            },
            ['principalId'],
          ),
        },
        ['principal'],
      ),
      ...['principal-enable', 'principal-disable', 'principal-revoke'].map(
        (action) =>
          authorizationMutation(action, { principalId: id }, ['principalId']),
      ),
      ...['workspace-membership-add', 'workspace-membership-remove'].map(
        (action) =>
          authorizationMutation(action, { principalId: id, workspaceId: id }, [
            'principalId',
            'workspaceId',
          ]),
      ),
      ...['workspace-grant-add', 'workspace-grant-remove'].map((action) =>
        authorizationMutation(
          action,
          { principalId: id, workspaceId: id, capability: text(256) },
          ['principalId', 'workspaceId', 'capability'],
        ),
      ),
      authorizationMutation(
        'credential-register',
        {
          credential: object(
            {
              credentialId: id,
              tokenDigest: localBearerTokenDigest,
              principalId: id,
              workspaceId: id,
            },
            ['credentialId', 'tokenDigest', 'principalId', 'workspaceId'],
          ),
        },
        ['credential'],
      ),
      authorizationMutation('credential-revoke', { credentialId: id }, [
        'credentialId',
      ]),
      authorizationMutation(
        'oauth-bind',
        {
          binding: object(
            {
              issuer: text(4096),
              subject: text(1024),
              principalId: id,
              workspaceId: id,
              credentialId: id,
            },
            ['issuer', 'subject', 'principalId', 'workspaceId'],
          ),
        },
        ['binding'],
      ),
      authorizationMutation(
        'oauth-unbind',
        { issuer: text(4096), subject: text(1024) },
        ['issuer', 'subject'],
      ),
      authorizationMutation(
        'visibility-policy-set',
        {
          target: policyTarget,
          expectedTargetRevision: positive,
          visibility: visibilityScope,
        },
        ['target', 'expectedTargetRevision', 'visibility'],
      ),
      object(
        {
          version: { const: 1 },
          action: { const: 'status' },
          target: policyTarget,
        },
        ['version', 'action'],
      ),
      object(
        {
          version: { const: 1 },
          action: { const: 'effective-policy' },
          target: policyTarget,
        },
        ['version', 'action', 'target'],
      ),
    ],
  },
  {
    oneOf: [
      object(
        {
          version: { const: 1 },
          action: text(64),
          status: { enum: ['committed', 'replayed'] },
          policyRevision,
          auditId: id,
          target: object({ kind: text(64), id }, ['kind', 'id']),
        },
        ['version', 'action', 'status', 'policyRevision', 'auditId', 'target'],
      ),
      object(
        {
          version: { const: 1 },
          action: { enum: ['status', 'effective-policy'] },
          policyRevision,
          value: { type: 'object', additionalProperties: true },
        },
        ['version', 'action', 'policyRevision', 'value'],
      ),
    ],
  },
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
const semanticCredentialSelector = {
  anyOf: [id, { type: 'null' }],
};
const semanticEndpoint = {
  type: 'string',
  pattern: '^https?://',
  maxLength: 4096,
};
const semanticProvider = object(
  {
    kind: { enum: ['openai-compatible', 'ollama-compatible'] },
    endpoint: semanticEndpoint,
    model: text(512),
    dimensions: {
      type: 'integer',
      minimum: 1,
      maximum: 65_536,
    },
    metric: { enum: ['cosine', 'dot', 'euclid'] },
    credentialSelector: semanticCredentialSelector,
    allowPrivateEndpoint: { type: 'boolean' },
    redirectPolicy: { const: 'error' },
  },
  [
    'kind',
    'endpoint',
    'model',
    'dimensions',
    'metric',
    'credentialSelector',
    'allowPrivateEndpoint',
    'redirectPolicy',
  ],
);
const semanticVector = {
  oneOf: [
    object({ kind: { const: 'sqlite' } }, ['kind']),
    object(
      {
        kind: { const: 'qdrant' },
        endpoint: semanticEndpoint,
        collection: text(256),
        credentialSelector: semanticCredentialSelector,
        allowPrivateEndpoint: { type: 'boolean' },
        redirectPolicy: { const: 'error' },
      },
      [
        'kind',
        'endpoint',
        'collection',
        'credentialSelector',
        'allowPrivateEndpoint',
        'redirectPolicy',
      ],
    ),
  ],
};
const semanticConfiguration = object(
  {
    version: { const: 1 },
    id,
    name: text(1024),
    provider: semanticProvider,
    vector: semanticVector,
  },
  ['version', 'id', 'name', 'provider', 'vector'],
);
operation('search_admin', 'search:admin', write, {
  oneOf: [
    object(
      {
        action: { const: 'configure' },
        options: object(
          {
            expectedRevision: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            idempotencyKey: id,
            configuration: semanticConfiguration,
          },
          ['expectedRevision', 'idempotencyKey', 'configuration'],
        ),
      },
      ['action', 'options'],
    ),
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
  ],
});

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

const propertyId = { type: 'string', pattern: '^P[1-9][0-9]*$' };
const statementId = text(256);
const rank = { enum: ['preferred', 'normal', 'deprecated'] };
const entityDatatype = {
  enum: [
    'wikibase-item',
    'wikibase-property',
    'wikibase-lexeme',
    'wikibase-form',
    'wikibase-sense',
    'entity-schema',
    'string',
    'external-id',
    'url',
    'commonsMedia',
    'monolingualtext',
    'time',
    'quantity',
    'globe-coordinate',
    'math',
    'musical-notation',
    'geo-shape',
    'tabular-data',
  ],
};
const entityValue = object(
  {
    'entity-type': {
      enum: ['item', 'property', 'lexeme', 'form', 'sense', 'entity-schema'],
    },
    'numeric-id': { type: 'integer', minimum: 1 },
    id: {
      type: 'string',
      pattern:
        '^(?:[PQ][1-9][0-9]*|L[1-9][0-9]*(?:-[FS][1-9][0-9]*)?|E[1-9][0-9]*)$',
    },
  },
  ['entity-type', 'id'],
);
const monolingualValue = object({ language: text(64), text: text(16_384) }, [
  'language',
  'text',
]);
const timeValue = object(
  {
    time: text(256),
    timezone: { type: 'integer' },
    before: { type: 'integer', minimum: 0 },
    after: { type: 'integer', minimum: 0 },
    precision: { type: 'integer', minimum: 0 },
    calendarmodel: text(4096),
  },
  ['time', 'timezone', 'before', 'after', 'precision', 'calendarmodel'],
);
const quantityValue = object(
  {
    amount: text(256),
    unit: text(4096),
    lowerBound: text(256),
    upperBound: text(256),
  },
  ['amount', 'unit'],
);
const coordinateValue = object(
  {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    altitude: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    precision: {
      anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }],
    },
    globe: text(4096),
  },
  ['latitude', 'longitude', 'altitude', 'precision', 'globe'],
);
const dataValue = object(
  {
    value: {
      anyOf: [
        text(1_000_000),
        entityValue,
        monolingualValue,
        timeValue,
        quantityValue,
        coordinateValue,
      ],
    },
    type: text(128),
  },
  ['value', 'type'],
);
const snak = {
  oneOf: [
    object(
      {
        snaktype: { const: 'value' },
        property: propertyId,
        hash: text(256),
        datatype: entityDatatype,
        datavalue: dataValue,
      },
      ['snaktype', 'property', 'datatype', 'datavalue'],
    ),
    object(
      {
        snaktype: { enum: ['somevalue', 'novalue'] },
        property: propertyId,
        hash: text(256),
        datatype: entityDatatype,
      },
      ['snaktype', 'property', 'datatype'],
    ),
  ],
};
const snakMap = {
  type: 'object',
  maxProperties: 200,
  patternProperties: {
    '^P[1-9][0-9]*$': {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: snak,
    },
  },
  additionalProperties: false,
};
const propertyOrder = {
  type: 'array',
  maxItems: 200,
  uniqueItems: true,
  items: propertyId,
};
const reference = object(
  { hash: text(256), snaks: snakMap, 'snaks-order': propertyOrder },
  ['hash', 'snaks', 'snaks-order'],
);
const statement = object(
  {
    id: statementId,
    type: { const: 'statement' },
    text: text(16_384),
    rank,
    mainsnak: snak,
    qualifiers: snakMap,
    'qualifiers-order': propertyOrder,
    references: {
      type: 'array',
      maxItems: 200,
      items: reference,
    },
  },
  [
    'id',
    'type',
    'text',
    'rank',
    'mainsnak',
    'qualifiers',
    'qualifiers-order',
    'references',
  ],
);
const sitelink = object(
  {
    site: text(256),
    title: text(16_384),
    badges: {
      type: 'array',
      maxItems: 200,
      uniqueItems: true,
      items: { type: 'string', pattern: '^Q[1-9][0-9]*$' },
    },
    url: text(4096),
  },
  ['site', 'title', 'badges'],
);
const command = (type, properties = {}, required = []) =>
  object({ type: { const: type }, ...properties }, ['type', ...required]);
const mutation = (kind, value) =>
  object({ kind: { const: kind }, authoredText: text(16_384), value }, [
    'kind',
    'authoredText',
    'value',
  ]);
const entityMutation = {
  oneOf: [
    mutation('label', {
      oneOf: [
        command('set-label', { language: text(64), value: text(16_384) }, [
          'language',
          'value',
        ]),
        command('remove-label', { language: text(64) }, ['language']),
      ],
    }),
    mutation('description', {
      oneOf: [
        command(
          'set-description',
          { language: text(64), value: text(16_384) },
          ['language', 'value'],
        ),
        command('remove-description', { language: text(64) }, ['language']),
      ],
    }),
    mutation('alias', {
      oneOf: [
        command('add-alias', { language: text(64), value: text(16_384) }, [
          'language',
          'value',
        ]),
        command(
          'remove-alias',
          {
            language: text(64),
            ordinal: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
          ['language', 'ordinal'],
        ),
      ],
    }),
    mutation('sitelink', {
      oneOf: [
        command('set-sitelink', { site: text(256), value: sitelink }, [
          'site',
          'value',
        ]),
        command('remove-sitelink', { site: text(256) }, ['site']),
      ],
    }),
    mutation('statement', {
      oneOf: [
        command('add-statement', { statement }, ['statement']),
        command('replace-statement', { statementId, statement }, [
          'statementId',
          'statement',
        ]),
        command('remove-statement', { statementId }, ['statementId']),
      ],
    }),
    mutation(
      'rank',
      command('set-statement-rank', { statementId, rank, text: text(16_384) }, [
        'statementId',
        'rank',
        'text',
      ]),
    ),
    mutation('qualifier', {
      oneOf: [
        command('add-qualifier', { statementId, snak, text: text(16_384) }, [
          'statementId',
          'snak',
          'text',
        ]),
        command(
          'remove-qualifier',
          {
            statementId,
            property: propertyId,
            ordinal: { type: 'integer', minimum: 0, maximum: 1_000_000 },
            text: text(16_384),
          },
          ['statementId', 'property', 'ordinal', 'text'],
        ),
      ],
    }),
    mutation('reference', {
      oneOf: [
        command(
          'add-reference',
          { statementId, reference, text: text(16_384) },
          ['statementId', 'reference', 'text'],
        ),
        command(
          'replace-reference',
          { statementId, hash: text(256), reference, text: text(16_384) },
          ['statementId', 'hash', 'reference', 'text'],
        ),
        command(
          'remove-reference',
          { statementId, hash: text(256), text: text(16_384) },
          ['statementId', 'hash', 'text'],
        ),
      ],
    }),
  ],
};
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
        items: entityMutation,
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

assert.equal(definitions.length, 52);
assert.equal(new Set(definitions.map(({ name }) => name)).size, 52);

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
