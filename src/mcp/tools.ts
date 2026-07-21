import type { WorkshopCapability } from '../protocol.js';
import { KNOWLEDGE_TOOL_NAMES } from '../server/knowledge.js';

export interface WorkshopToolDefinition {
  name: string;
  title: string;
  description: string;
  capability: WorkshopCapability;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

const string = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({
  type: 'integer',
  minimum: 0,
  description,
});
const object = (description: string) => ({
  type: 'object',
  description,
  additionalProperties: true,
});
const array = (items: unknown, description: string) => ({
  type: 'array',
  items,
  description,
});

function tool(
  name: string,
  title: string,
  description: string,
  capability: WorkshopCapability,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  additionalProperties = false,
): WorkshopToolDefinition {
  return {
    name,
    title,
    description,
    capability,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties,
    },
  };
}

const taskFilterProperties = {
  role: string('Advisory role label to match exactly.'),
  state: {
    type: 'string',
    enum: ['unclaimed', 'claimed', 'completed', 'archived'],
    description: 'Derived task state.',
  },
  claimed: { type: 'boolean', description: 'Filter by current claim flag.' },
  updatedAfter: string('ISO timestamp lower bound.'),
  text: string('Text to match in task description or prompt.'),
  cursor: string('Opaque cursor returned by the previous page.'),
  limit: integer('Page size.'),
};

const taskInputProperties = {
  idempotencyKey: string('Stable key for safe retries.'),
  description: string('Short human-readable task description.'),
  role: string('Optional advisory role label; never grants authorization.'),
  prompt: string('Complete instructions for the agent performing the task.'),
  contextQueries: array(
    {
      type: 'object',
      properties: {
        label: string('Optional result label.'),
        sparql: string(
          'Read-only SPARQL query, validated and dry-run before save.',
        ),
      },
      required: ['sparql'],
      additionalProperties: false,
    },
    'Queries compiled against current graph state whenever the packet is read.',
  ),
  memorySlugs: array(
    string('Memory slug.'),
    'Existing memories to resolve into the packet.',
  ),
};

const taskTools = [
  tool(
    'list_tasks',
    'List tasks',
    'List tasks with stable cursor pagination and optional state filters.',
    'read',
    taskFilterProperties,
  ),
  tool(
    'search_tasks',
    'Search tasks',
    'Search existing descriptions and prompts before creating overlapping work.',
    'read',
    taskFilterProperties,
  ),
  tool(
    'get_task_packet',
    'Get task packet',
    'Compile an ephemeral packet from the current task, current SPARQL results, and current memories. This never claims the task.',
    'read',
    { id: string('Task ID.') },
    ['id'],
  ),
  tool(
    'create_task',
    'Create task',
    'Validate all fields, dry-run every read-only context query, verify every memory, and atomically create a durable task.',
    'task-write',
    taskInputProperties,
    ['description', 'prompt'],
  ),
  tool(
    'update_task',
    'Update task',
    'Optimistically update an active task. Supply the exact updatedAt value previously read; completed or archived tasks cannot be reopened.',
    'task-write',
    {
      id: string('Task ID.'),
      expectedUpdatedAt: string('Exact current task updatedAt timestamp.'),
      ...taskInputProperties,
    },
    ['id', 'expectedUpdatedAt'],
  ),
  tool(
    'archive_task',
    'Archive task',
    'Revision-conditionally archive an unclaimed task. Claimed-task archival requires an administrative HTTP integration and is not available here.',
    'task-write',
    {
      id: string('Task ID.'),
      expectedUpdatedAt: string('Exact current task updatedAt timestamp.'),
    },
    ['id', 'expectedUpdatedAt'],
  ),
  tool(
    'claim_task',
    'Claim task',
    'Atomically claim an unclaimed active task. Exactly one concurrent claimant can succeed.',
    'task-write',
    { id: string('Task ID.') },
    ['id'],
  ),
  tool(
    'complete_task',
    'Complete task',
    'Complete an exactly matching claimed task with a nonempty result. Negative or inconclusive results are valid.',
    'task-write',
    { id: string('Task ID.'), result: string('Nonempty task outcome.') },
    ['id', 'result'],
  ),
];

const memoryTools = [
  tool(
    'list_memories',
    'List memories',
    'List reusable operating guidance with stable pagination.',
    'read',
    {
      text: string('Text to search.'),
      cursor: string('Opaque page cursor.'),
      limit: integer('Page size.'),
    },
  ),
  tool(
    'get_memory',
    'Get memory',
    'Read one reusable memory by slug.',
    'read',
    { slug: string('Memory slug.') },
    ['slug'],
  ),
  tool(
    'upsert_memory',
    'Upsert memory',
    'Create or replace reusable operating guidance. Memories should not duplicate changing graph facts.',
    'memory-write',
    {
      slug: string('Lowercase hyphenated slug.'),
      description: string('Purpose of this guidance.'),
      content: string('Reusable guidance.'),
      expectedUpdatedAt: string('Optional optimistic concurrency timestamp.'),
    },
    ['slug', 'description', 'content'],
  ),
];

const sparqlTools = [
  tool(
    'validate_sparql',
    'Validate SPARQL',
    'Parse a SPARQL query and enforce Workshop read-only and federated SERVICE policy.',
    'read',
    { sparql: string('SPARQL query.') },
    ['sparql'],
  ),
  tool(
    'dry_run_sparql',
    'Dry-run SPARQL',
    'Execute a validated read-only query with a very small bounded result to prove it can run.',
    'read',
    { sparql: string('SPARQL query.') },
    ['sparql'],
  ),
  tool(
    'query_sparql',
    'Query SPARQL',
    'Execute a validated read-only query under configured timeout and result limits.',
    'read',
    { sparql: string('SPARQL query.') },
    ['sparql'],
  ),
];

const knowledgeDescriptions: Record<string, string> = {
  search_entities: 'Search Taproot entity labels, descriptions, and aliases.',
  get_entity: 'Read one canonical Taproot entity and lifecycle metadata.',
  get_entities: 'Read up to 100 canonical Taproot entities.',
  create_item:
    'Create one Taproot Item and return its entity and revision IDs.',
  create_property:
    'Create one typed Taproot Property and return its entity and revision IDs.',
  set_label: 'Set an entity label using expected-revision concurrency control.',
  set_description:
    'Set an entity description using expected-revision concurrency control.',
  add_alias: 'Add an entity alias using expected-revision concurrency control.',
  remove_alias:
    'Remove an alias by language and ordinal using expected-revision concurrency control.',
  add_sitelink:
    'Set an Item sitelink using expected-revision concurrency control.',
  remove_sitelink:
    'Remove an Item sitelink using expected-revision concurrency control.',
  add_statement: 'Add a complete Wikibase-shaped statement through Taproot.',
  replace_statement: 'Replace one statement by ID through Taproot.',
  remove_statement: 'Remove one statement by ID through Taproot.',
  set_statement_rank: 'Set one statement rank through Taproot.',
  add_qualifier: 'Add a typed qualifier snak to one statement through Taproot.',
  remove_qualifier:
    'Remove a qualifier by property and ordinal through Taproot.',
  add_reference: 'Add a complete reference to one statement through Taproot.',
  remove_reference: 'Remove a statement reference by hash through Taproot.',
  export_entity_json: 'Export canonical Wikibase-shaped entity JSON.',
};

const knowledgeReadTools = new Set([
  'search_entities',
  'get_entity',
  'get_entities',
  'export_entity_json',
]);

const knowledgeProperties: Record<string, Record<string, unknown>> = {
  search_entities: {
    query: string('Search text.'),
    language: string('Optional language.'),
    cursor: string('Opaque cursor.'),
    limit: integer('Page size.'),
  },
  get_entity: { entityId: string('Q or P entity ID.') },
  get_entities: {
    entityIds: array(string('Q or P entity ID.'), 'Entity IDs to read.'),
  },
  create_item: {
    labels: object('Language label map.'),
    descriptions: object('Language description map.'),
    aliases: object('Language alias map.'),
    claims: object('Initial statements by property.'),
    sitelinks: object('Initial sitelinks.'),
  },
  create_property: {
    datatype: string('Taproot entity datatype.'),
    labels: object('Language label map.'),
    descriptions: object('Language description map.'),
    aliases: object('Language alias map.'),
  },
  set_label: {
    entityId: string('Entity ID.'),
    language: string('BCP 47 language code.'),
    value: string('Label.'),
    expectedRevision: integer('Current revision.'),
  },
  set_description: {
    entityId: string('Entity ID.'),
    language: string('BCP 47 language code.'),
    value: string('Description.'),
    expectedRevision: integer('Current revision.'),
  },
  add_alias: {
    entityId: string('Entity ID.'),
    language: string('BCP 47 language code.'),
    value: string('Alias.'),
    expectedRevision: integer('Current revision.'),
  },
  remove_alias: {
    entityId: string('Entity ID.'),
    language: string('BCP 47 language code.'),
    ordinal: integer('Zero-based alias ordinal.'),
    expectedRevision: integer('Current revision.'),
  },
  add_sitelink: {
    entityId: string('Item ID.'),
    site: string('Site key.'),
    sitelink: object('Wikibase sitelink.'),
    expectedRevision: integer('Current revision.'),
  },
  remove_sitelink: {
    entityId: string('Item ID.'),
    site: string('Site key.'),
    expectedRevision: integer('Current revision.'),
  },
  add_statement: {
    entityId: string('Entity ID.'),
    statement: object('Complete Wikibase statement.'),
    expectedRevision: integer('Current revision.'),
  },
  replace_statement: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    statement: object('Replacement statement.'),
    expectedRevision: integer('Current revision.'),
  },
  remove_statement: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    expectedRevision: integer('Current revision.'),
  },
  set_statement_rank: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    rank: { type: 'string', enum: ['preferred', 'normal', 'deprecated'] },
    expectedRevision: integer('Current revision.'),
  },
  add_qualifier: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    snak: object('Typed qualifier snak.'),
    expectedRevision: integer('Current revision.'),
  },
  remove_qualifier: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    property: string('Property ID.'),
    ordinal: integer('Zero-based ordinal.'),
    expectedRevision: integer('Current revision.'),
  },
  add_reference: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    reference: object('Complete reference.'),
    expectedRevision: integer('Current revision.'),
  },
  remove_reference: {
    entityId: string('Entity ID.'),
    statementId: string('Statement ID.'),
    hash: string('Reference hash.'),
    expectedRevision: integer('Current revision.'),
  },
  export_entity_json: { entityId: string('Entity ID.') },
};

const required: Record<string, string[]> = {
  search_entities: ['query'],
  get_entity: ['entityId'],
  get_entities: ['entityIds'],
  create_property: ['datatype'],
  set_label: ['entityId', 'language', 'value', 'expectedRevision'],
  set_description: ['entityId', 'language', 'value', 'expectedRevision'],
  add_alias: ['entityId', 'language', 'value', 'expectedRevision'],
  remove_alias: ['entityId', 'language', 'ordinal', 'expectedRevision'],
  add_sitelink: ['entityId', 'site', 'sitelink', 'expectedRevision'],
  remove_sitelink: ['entityId', 'site', 'expectedRevision'],
  add_statement: ['entityId', 'statement', 'expectedRevision'],
  replace_statement: [
    'entityId',
    'statementId',
    'statement',
    'expectedRevision',
  ],
  remove_statement: ['entityId', 'statementId', 'expectedRevision'],
  set_statement_rank: ['entityId', 'statementId', 'rank', 'expectedRevision'],
  add_qualifier: ['entityId', 'statementId', 'snak', 'expectedRevision'],
  remove_qualifier: [
    'entityId',
    'statementId',
    'property',
    'ordinal',
    'expectedRevision',
  ],
  add_reference: ['entityId', 'statementId', 'reference', 'expectedRevision'],
  remove_reference: ['entityId', 'statementId', 'hash', 'expectedRevision'],
  export_entity_json: ['entityId'],
};

const knowledgeTools = KNOWLEDGE_TOOL_NAMES.map((name) =>
  tool(
    name,
    name
      .split('_')
      .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
      .join(' '),
    knowledgeDescriptions[name] ?? name,
    knowledgeReadTools.has(name) ? 'read' : 'knowledge-write',
    knowledgeProperties[name] ?? {},
    required[name] ?? [],
  ),
);

export const workshopTools: readonly WorkshopToolDefinition[] = [
  ...taskTools,
  ...memoryTools,
  ...sparqlTools,
  ...knowledgeTools,
] as const;
