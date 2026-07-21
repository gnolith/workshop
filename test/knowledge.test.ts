import { describe, expect, it, vi } from 'vitest';
import { WorkshopError } from '../src/protocol/errors.js';
import {
  createTaprootKnowledgeService,
  KNOWLEDGE_TOOL_NAMES,
  type TaprootRepositoryLike,
} from '../src/server/knowledge.js';

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
});
