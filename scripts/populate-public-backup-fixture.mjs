/* global fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const [origin, token] = process.argv.slice(2);
if (!origin || !token) {
  throw new Error(
    'usage: node scripts/populate-public-backup-fixture.mjs <origin> <bearer>',
  );
}

let requestId = 1;
const request = async (name, argumentsValue) => {
  const response = await fetch(`${origin.replace(/\/$/u, '')}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }),
  });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  return response.json();
};
const call = async (name, argumentsValue) => {
  const body = await request(name, argumentsValue);
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  return body.result.structuredContent;
};

const initialStatus = await call('gnolith_status', {});
const workspaceId = initialStatus.activeWorkspaceId;
assert.equal(typeof workspaceId, 'string');

await call('create_property', {
  idempotencyKey: 'backup-fixture-property-p1-v1',
  authoredText: 'Create the fixture source property.',
  data: {
    id: 'P1',
    datatype: 'string',
    labels: { en: { language: 'en', value: 'Fixture source' } },
  },
});
await call('create_item', {
  idempotencyKey: 'backup-fixture-item-q1-v1',
  authoredText: 'Create the fixture subject.',
  data: {
    id: 'Q1',
    labels: { en: { language: 'en', value: 'Backup fixture subject' } },
  },
});

const statementId = 'Q1$backup-fixture-statement';
const valueSnak = {
  snaktype: 'value',
  property: 'P1',
  datatype: 'string',
  datavalue: { value: 'fixture value', type: 'string' },
};
await call('mutate_entity', {
  entityId: 'Q1',
  expectedRevision: 1,
  idempotencyKey: 'backup-fixture-statement-v1',
  mutations: [
    {
      kind: 'statement',
      authoredText: 'Add the fixture statement.',
      value: {
        type: 'add-statement',
        statement: {
          id: statementId,
          type: 'statement',
          text: 'Add the fixture statement.',
          rank: 'normal',
          mainsnak: valueSnak,
          qualifiers: {},
          'qualifiers-order': [],
          references: [],
        },
      },
    },
  ],
});
await call('mutate_entity', {
  entityId: 'Q1',
  expectedRevision: 2,
  idempotencyKey: 'backup-fixture-statement-details-v1',
  mutations: [
    {
      kind: 'qualifier',
      authoredText: 'Qualify the fixture statement.',
      value: {
        type: 'add-qualifier',
        statementId,
        snak: {
          ...valueSnak,
          datavalue: { value: 'qualified', type: 'string' },
        },
        text: 'Qualify the fixture statement.',
      },
    },
    {
      kind: 'reference',
      authoredText: 'Reference the fixture statement.',
      value: {
        type: 'add-reference',
        statementId,
        reference: {
          hash: 'backup-fixture-reference',
          snaks: {
            P1: [
              {
                ...valueSnak,
                datavalue: { value: 'source', type: 'string' },
              },
            ],
          },
          'snaks-order': ['P1'],
        },
        text: 'Reference the fixture statement.',
      },
    },
    {
      kind: 'rank',
      authoredText: 'Prefer the fixture statement.',
      value: {
        type: 'set-statement-rank',
        statementId,
        rank: 'preferred',
        text: 'Prefer the fixture statement.',
      },
    },
  ],
});

const resourceText = 'Inline backup fixture resource payload.';
const resourceBytes = Buffer.from(resourceText, 'utf8');
await call('create_resource', {
  idempotencyKey: 'backup-fixture-resource-v1',
  data: {
    id: 'resource:backup-fixture',
    itemId: 'Q1',
    title: 'Backup fixture resource',
    payload: { kind: 'inline-text', text: resourceText },
    mediaType: 'text/plain',
    language: 'en',
    integrity: {
      algorithm: 'sha256',
      digest: createHash('sha256').update(resourceBytes).digest('hex'),
      byteLength: resourceBytes.byteLength,
    },
  },
});
await call('create_annotation', {
  idempotencyKey: 'backup-fixture-annotation-v1',
  data: {
    id: 'annotation:backup-fixture',
    body: {
      kind: 'text',
      text: 'Backup fixture annotation body.',
      mediaType: 'text/plain',
      language: 'en',
    },
    target: {
      kind: 'resource',
      sourceId: 'resource:backup-fixture',
      selector: { type: 'FragmentSelector', value: 'line=1' },
    },
    motivation: 'commenting',
  },
});

const task = await call('create_task', {
  idempotencyKey: 'backup-fixture-task-v1',
  description: 'Complete the backup fixture task',
  prompt: 'Return the deterministic fixture outcome.',
  data: { fixture: true },
});
const taskId = task.id ?? task.taskId;
assert.equal(typeof taskId, 'string');
const claims = await Promise.allSettled([
  call('claim_task', { taskId, leaseSeconds: 300 }),
  call('claim_task', { taskId, leaseSeconds: 300 }),
]);
const winner = claims.find((entry) => entry.status === 'fulfilled')?.value;
assert.ok(winner?.leaseToken, 'one task claim must win');
const completionInput = {
  taskId,
  leaseToken: winner.leaseToken,
  expectedRevision: winner.task?.revision ?? winner.revision,
  idempotencyKey: 'backup-fixture-task-complete-v1',
  result: 'Backup fixture completed.',
  outcomeKind: 'success',
};
const completion = await call('complete_task', completionInput);
assert.deepEqual(await call('complete_task', completionInput), completion);

const memory = await call('upsert_memory', {
  slug: 'backup-fixture-memory',
  idempotencyKey: 'backup-fixture-memory-v1',
  description: 'Backup fixture memory',
  content: 'First deterministic memory revision.',
});
await call('upsert_memory', {
  slug: memory.slug,
  expectedRevision: memory.revision,
  idempotencyKey: 'backup-fixture-memory-v2',
  description: 'Backup fixture memory',
  content: 'Second deterministic memory revision.',
});
const prompt = await call('create_prompt', {
  idempotencyKey: 'backup-fixture-prompt-v1',
  name: 'backup-fixture-prompt',
  promptText: 'First deterministic prompt revision.',
  data: { fixture: true },
});
await call('update_prompt', {
  promptId: prompt.id,
  expectedRevision: prompt.revision,
  idempotencyKey: 'backup-fixture-prompt-v2',
  patch: { promptText: 'Second deterministic prompt revision.' },
});

for (let index = 0; index < 25; index += 1) {
  const entityNumber = 100 + index;
  await call('create_item', {
    idempotencyKey: `backup-fixture-lag-q${entityNumber}-v1`,
    authoredText: `Create lag fixture item ${entityNumber}.`,
    data: {
      id: `Q${entityNumber}`,
      labels: {
        en: {
          language: 'en',
          value: `Backup fixture lag item ${entityNumber}`,
        },
      },
    },
  });
}

let policyRevision = (await call('gnolith_status', {})).authorizationRevision;
const administer = async (action) => {
  const result = await call('authorization_admin', {
    version: 1,
    expectedPolicyRevision: policyRevision,
    ...action,
  });
  policyRevision = result.policyRevision;
  return result;
};
await administer({
  action: 'principal-create',
  idempotencyKey: 'backup-fixture-principal-v1',
  principal: { principalId: 'principal:backup-fixture', enabled: true },
});
await administer({
  action: 'workspace-membership-add',
  idempotencyKey: 'backup-fixture-membership-v1',
  principalId: 'principal:backup-fixture',
  workspaceId,
});
for (const capability of ['read', 'admin', 'search:admin']) {
  await administer({
    action: 'workspace-grant-add',
    idempotencyKey: `backup-fixture-grant-${capability}-v1`,
    principalId: 'principal:backup-fixture',
    workspaceId,
    capability,
  });
}
const delegatedBytes = Buffer.from(
  Uint8Array.from({ length: 32 }, (_, index) => index + 31),
);
const delegatedToken = delegatedBytes.toString('base64url');
const delegatedDigest = createHash('sha256')
  .update(Buffer.from('gnolith-local-bearer-v1\0', 'utf8'))
  .update(delegatedBytes)
  .digest('hex');
await administer({
  action: 'credential-register',
  idempotencyKey: 'backup-fixture-credential-v1',
  credential: {
    credentialId: 'credential:backup-fixture',
    tokenDigest: delegatedDigest,
    principalId: 'principal:backup-fixture',
    workspaceId,
  },
});
const auditBeforeVisibility = await call('authorization_admin', {
  version: 1,
  action: 'status',
});
const q1VisibilityArguments = {
  version: 1,
  action: 'visibility-policy-set',
  expectedPolicyRevision: policyRevision,
  idempotencyKey: 'backup-fixture-q1-policy-v1',
  target: { kind: 'entity', id: 'Q1' },
  expectedTargetRevision: 3,
  visibility: {
    version: 1,
    clauses: [[{ kind: 'workspace', workspaceId }]],
  },
};
const q1Visibility = await call('authorization_admin', q1VisibilityArguments);
policyRevision = q1Visibility.policyRevision;
const q1VisibilityReplay = await call(
  'authorization_admin',
  q1VisibilityArguments,
);
assert.equal(q1VisibilityReplay.status, 'replayed');
assert.equal(q1VisibilityReplay.auditId, q1Visibility.auditId);
const q1VisibilityConflict = await request('authorization_admin', {
  ...q1VisibilityArguments,
  visibility: { version: 1, clauses: [] },
});
assert.equal(
  q1VisibilityConflict.error?.data?.code ??
    q1VisibilityConflict.result?.structuredContent?.code,
  'conflict',
);
const auditAfterVisibility = await call('authorization_admin', {
  version: 1,
  action: 'status',
});
assert.equal(
  auditAfterVisibility.value.audits,
  auditBeforeVisibility.value.audits + 1,
);
const q1AfterVisibility = await call('get_entity', { entityId: 'Q1' });
assert.equal(q1AfterVisibility.entity.lastrevid, 4);
const q1VisibilityRevision = await call('entity_revision', {
  entityId: 'Q1',
  revision: 4,
});
assert.match(JSON.stringify(q1VisibilityRevision), /"id":"Q1"/u);
const q1EffectivePolicy = await call('authorization_admin', {
  version: 1,
  action: 'effective-policy',
  target: { kind: 'entity', id: 'Q1' },
});
assert.equal(q1EffectivePolicy.value.sourceRevision, 4);
assert.equal(
  q1EffectivePolicy.value.sourcePolicyRevision,
  q1Visibility.policyRevision,
);
assert.deepEqual(q1EffectivePolicy.value.visibility, {
  version: 1,
  clauses: [[{ kind: 'workspace', workspaceId }]],
});

process.stdout.write(
  `${JSON.stringify({
    format: 'gnolith-workshop-public-backup-fixture-v1',
    taskId,
    promptId: prompt.id,
    completionInput,
    delegatedToken,
    q1Visibility,
    q1EffectivePolicy,
    catalogDigest:
      'af455b4d6ab3560bca9c0ab48e9db7bd3cbcfa166ace875578d88d182069071f',
  })}\n`,
);
