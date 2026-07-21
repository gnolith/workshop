import { describe, expect, it, vi } from 'vitest';
import { WorkshopError } from '../src/protocol/errors.js';
import {
  createTaprootKnowledgeService,
  KNOWLEDGE_TOOL_NAMES,
  type TaprootRepositoryLike,
} from '../src/server/knowledge.js';

const statement = (text: string) => ({
  id: 'Q1$statement',
  type: 'statement' as const,
  text,
  rank: 'normal' as const,
  mainsnak: { property: 'P1' as const },
  qualifiers: {},
  'qualifiers-order': [],
  references: [],
});

function repository(): TaprootRepositoryLike {
  const result = async () => ({ entityId: 'Q1', newRevision: 2 });
  return {
    searchEntitiesPage: vi.fn(result),
    getEntity: vi.fn(result),
    createItem: vi.fn(result),
    createProperty: vi.fn(result),
    setLabel: vi.fn(result),
    setDescription: vi.fn(result),
    addAlias: vi.fn(result),
    removeAlias: vi.fn(result),
    setSitelink: vi.fn(result),
    removeSitelink: vi.fn(result),
    addStatement: vi.fn(result),
    replaceStatement: vi.fn(result),
    removeStatement: vi.fn(result),
    setStatementRank: vi.fn(result),
    addQualifier: vi.fn(result),
    removeQualifier: vi.fn(result),
    addReference: vi.fn(result),
    removeReference: vi.fn(result),
  };
}

describe('Taproot-backed knowledge adapter', () => {
  it('exposes the complete approved family and delegates expected revisions', async () => {
    expect(KNOWLEDGE_TOOL_NAMES).toHaveLength(20);
    const taproot = repository();
    const service = createTaprootKnowledgeService(taproot);
    await service.call(
      {
        name: 'set_label',
        input: {
          entityId: 'Q1',
          language: 'en',
          value: 'Ada',
          expectedRevision: 1,
        },
      },
      { principalId: 'agent:cataloguer', requestId: 'request-1' },
    );
    expect(taproot.setLabel).toHaveBeenCalledWith(
      'Q1',
      'en',
      'Ada',
      expect.objectContaining({
        expectedRevision: 1,
        attribution: expect.objectContaining({ id: 'agent:cataloguer' }),
        requestId: 'request-1',
      }),
    );
  });

  it('rejects mutation calls without an expected revision', async () => {
    const service = createTaprootKnowledgeService(repository());
    await expect(
      service.call(
        {
          name: 'remove_statement',
          input: { entityId: 'Q1', statementId: 'Q1$statement' },
        },
        { principalId: 'agent:test' },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('reports changed statement IDs for statement-level writes', async () => {
    const service = createTaprootKnowledgeService(repository());
    await expect(
      service.call(
        {
          name: 'add_reference',
          input: {
            entityId: 'Q1',
            statementId: 'Q1$statement',
            reference: { snaks: {} },
            text: 'Ada Lovelace worked as a programmer.',
            expectedRevision: 1,
          },
        },
        { principalId: 'agent:test' },
      ),
    ).resolves.toMatchObject({
      entityId: 'Q1',
      newRevision: 2,
      changedStatementIds: ['Q1$statement'],
    });
  });

  it('propagates Taproot stale-revision conflicts', async () => {
    const taproot = repository();
    taproot.setLabel = vi.fn(async () => {
      throw new WorkshopError('conflict', 'Revision 1 is stale', 409);
    });
    const service = createTaprootKnowledgeService(taproot);
    await expect(
      service.call(
        {
          name: 'set_label',
          input: {
            entityId: 'Q1',
            language: 'en',
            value: 'Ada',
            expectedRevision: 1,
          },
        },
        { principalId: 'agent:test' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it.each([undefined, '', '   ', '\u00a0', '\u2003', '\u202f', '\u200b'])(
    'rejects missing or Unicode-blank authored text before delegation (%j)',
    async (authored) => {
      const taproot = repository();
      const service = createTaprootKnowledgeService(taproot);
      await expect(
        service.call(
          {
            name: 'set_statement_rank',
            input: {
              entityId: 'Q1',
              statementId: 'Q1$statement',
              rank: 'preferred',
              text: authored,
              expectedRevision: 1,
            },
          },
          { principalId: 'agent:test' },
        ),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        details: { field: 'text' },
      });
      expect(taproot.setStatementRank).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '\u00a0', '\u200b'])(
    'rejects statement objects without authored text (%j)',
    async (authored) => {
      const taproot = repository();
      const service = createTaprootKnowledgeService(taproot);
      const candidate = statement('valid');
      (candidate as { text: unknown }).text = authored;
      await expect(
        service.call(
          {
            name: 'add_statement',
            input: {
              entityId: 'Q1',
              statement: candidate,
              expectedRevision: 1,
            },
          },
          { principalId: 'agent:test' },
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(taproot.addStatement).not.toHaveBeenCalled();
    },
  );

  it('validates authored text in create_item claims before delegation', async () => {
    const taproot = repository();
    const service = createTaprootKnowledgeService(taproot);
    await expect(
      service.call(
        {
          name: 'create_item',
          input: { claims: { P1: [statement('\u2003')] } },
        },
        { principalId: 'agent:test' },
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { field: 'claims.P1[0].text' },
    });
    expect(taproot.createItem).not.toHaveBeenCalled();

    const authored = statement('  A deliberately authored claim.  ');
    await service.call(
      {
        name: 'create_item',
        input: { claims: { P1: [authored] } },
      },
      { principalId: 'agent:test' },
    );
    expect(taproot.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ claims: { P1: [authored] } }),
    );
  });

  it('forwards unchanged-but-explicit and changed authored text exactly', async () => {
    const taproot = repository();
    const service = createTaprootKnowledgeService(taproot);
    const unchanged = '  Existing authored explanation.  ';
    const changed = 'Changed authored explanation.';

    await service.call(
      {
        name: 'set_statement_rank',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          rank: 'preferred',
          text: unchanged,
          expectedRevision: 1,
        },
      },
      { principalId: 'agent:test' },
    );
    expect(taproot.setStatementRank).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      'preferred',
      unchanged,
      expect.objectContaining({ expectedRevision: 1 }),
    );

    await service.call(
      {
        name: 'add_qualifier',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          snak: { property: 'P2' },
          text: changed,
          expectedRevision: 2,
        },
      },
      { principalId: 'agent:test' },
    );
    expect(taproot.addQualifier).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      { property: 'P2' },
      changed,
      expect.objectContaining({ expectedRevision: 2 }),
    );
  });

  it('forwards add and replacement statement text inside the exact object', async () => {
    const taproot = repository();
    const service = createTaprootKnowledgeService(taproot);
    const added = statement('  Explicit text for the added statement.  ');
    const replacement = statement('Changed text for the replacement.');

    await service.call(
      {
        name: 'add_statement',
        input: { entityId: 'Q1', statement: added, expectedRevision: 1 },
      },
      { principalId: 'agent:test' },
    );
    expect(taproot.addStatement).toHaveBeenCalledWith(
      'Q1',
      added,
      expect.objectContaining({ expectedRevision: 1 }),
    );

    await service.call(
      {
        name: 'replace_statement',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          statement: replacement,
          expectedRevision: 2,
        },
      },
      { principalId: 'agent:test' },
    );
    expect(taproot.replaceStatement).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      replacement,
      expect.objectContaining({ expectedRevision: 2 }),
    );
  });

  it('forwards authored text in every qualifier/reference revision operation', async () => {
    const taproot = repository();
    const service = createTaprootKnowledgeService(taproot);
    const context = { principalId: 'agent:test' };

    await service.call(
      {
        name: 'remove_qualifier',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          property: 'P2',
          ordinal: 0,
          text: 'Qualifier removed after review.',
          expectedRevision: 3,
        },
      },
      context,
    );
    expect(taproot.removeQualifier).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      'P2',
      0,
      'Qualifier removed after review.',
      expect.objectContaining({ expectedRevision: 3 }),
    );

    await service.call(
      {
        name: 'add_reference',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          reference: { hash: 'ref' },
          text: 'Reference added from the primary source.',
          expectedRevision: 4,
        },
      },
      context,
    );
    expect(taproot.addReference).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      { hash: 'ref' },
      'Reference added from the primary source.',
      expect.objectContaining({ expectedRevision: 4 }),
    );

    await service.call(
      {
        name: 'remove_reference',
        input: {
          entityId: 'Q1',
          statementId: 'Q1$statement',
          hash: 'ref',
          text: 'Reference removed because it was superseded.',
          expectedRevision: 5,
        },
      },
      context,
    );
    expect(taproot.removeReference).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      'ref',
      'Reference removed because it was superseded.',
      expect.objectContaining({ expectedRevision: 5 }),
    );
  });

  it('keeps remove_statement text-exempt and preserves text in export', async () => {
    const taproot = repository();
    taproot.getEntity = vi.fn(async () => ({
      entity: { claims: { P1: [statement('Persisted authored text.')] } },
    }));
    const service = createTaprootKnowledgeService(taproot);
    await expect(
      service.call(
        {
          name: 'remove_statement',
          input: {
            entityId: 'Q1',
            statementId: 'Q1$statement',
            expectedRevision: 1,
          },
        },
        { principalId: 'agent:test' },
      ),
    ).resolves.toMatchObject({ changedStatementIds: ['Q1$statement'] });
    expect(taproot.removeStatement).toHaveBeenCalledWith(
      'Q1',
      'Q1$statement',
      expect.objectContaining({ expectedRevision: 1 }),
    );

    const exported = await service.call(
      { name: 'export_entity_json', input: { entityId: 'Q1' } },
      { principalId: 'agent:test' },
    );
    expect(JSON.parse(exported as string)).toMatchObject({
      claims: { P1: [{ text: 'Persisted authored text.' }] },
    });
  });
});
