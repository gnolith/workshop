import { describe, expect, it, vi } from 'vitest';
import {
  createTaprootKnowledgeService,
  KNOWLEDGE_MUTATION_TOOL_NAMES,
  KNOWLEDGE_READ_TOOL_NAMES,
  KNOWLEDGE_TOOL_NAMES,
  type TaprootAuthorizedReaderLike,
} from '../src/server/knowledge.js';
import { TEST_AUTHORIZATION } from './helpers.js';

function reader(): TaprootAuthorizedReaderLike {
  return {
    searchEntities: vi.fn(async () => ({ items: [], cursor: null })),
    getEntity: vi.fn(async (entityId) => ({
      entityId,
      entity: { id: entityId, labels: { en: { value: 'Ada' } } },
      revision: 2,
    })),
  };
}

function service(taproot = reader()) {
  const authorization = {
    async getInstallationAuthorizationState() {
      return {
        installationId: TEST_AUTHORIZATION.installationId,
        authorizationRevision: TEST_AUTHORIZATION.authorizationRevision,
        searchGeneration: 1,
      };
    },
  };
  const authorizedReader = vi.fn(() => taproot);
  return {
    taproot,
    authorization,
    authorizedReader,
    service: createTaprootKnowledgeService({
      authorization,
      authorizedReader,
      health: async () => true,
    }),
  };
}

const context = { ...TEST_AUTHORIZATION, requestId: 'request-1' };

describe('Taproot-backed knowledge adapter', () => {
  it('exposes four authorized reads and keeps every mutation fail-closed', () => {
    expect(KNOWLEDGE_TOOL_NAMES).toHaveLength(20);
    expect(KNOWLEDGE_READ_TOOL_NAMES).toEqual([
      'search_entities',
      'get_entity',
      'get_entities',
      'export_entity_json',
    ]);
    expect(KNOWLEDGE_MUTATION_TOOL_NAMES).toHaveLength(16);
  });

  it('routes candidate search only through the authorized reader using the shared source', async () => {
    const fixture = service();
    await fixture.service.call(
      {
        name: 'search_entities',
        input: { query: 'Ada', language: 'en', limit: 5 },
      },
      context,
    );
    expect(fixture.taproot.searchEntities).toHaveBeenCalledWith('Ada', {
      language: 'en',
      limit: 5,
    });
    expect(fixture.authorizedReader).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: TEST_AUTHORIZATION.installationId,
      }),
      fixture.authorization,
    );
  });

  it('hydrates single and bounded batch reads through the authorized reader', async () => {
    const fixture = service();
    await expect(
      fixture.service.call(
        { name: 'get_entity', input: { entityId: 'Q1' } },
        context,
      ),
    ).resolves.toMatchObject({ entityId: 'Q1' });
    await expect(
      fixture.service.call(
        { name: 'get_entities', input: { entityIds: ['Q1', 'P2'] } },
        context,
      ),
    ).resolves.toHaveLength(2);
    await expect(
      fixture.service.call(
        {
          name: 'get_entities',
          input: { entityIds: Array.from({ length: 101 }, () => 'Q1') },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('exports only authorized hydrated entity JSON', async () => {
    const fixture = service();
    const exported = await fixture.service.call(
      { name: 'export_entity_json', input: { entityId: 'Q1' } },
      context,
    );
    expect(JSON.parse(exported as string)).toEqual({
      id: 'Q1',
      labels: { en: { value: 'Ada' } },
    });
  });

  it.each(KNOWLEDGE_MUTATION_TOOL_NAMES)(
    'denies unavailable mutation %s before reader or writer access',
    async (name) => {
      const fixture = service();
      await expect(
        fixture.service.call({ name, input: { entityId: 'Q1' } }, context),
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: 'Authorization denied',
      });
      expect(fixture.authorizedReader).not.toHaveBeenCalled();
      expect(fixture.taproot.getEntity).not.toHaveBeenCalled();
      expect(fixture.taproot.searchEntities).not.toHaveBeenCalled();
    },
  );

  it('fails health closed when the host probe throws', async () => {
    const fixture = service();
    const unavailable = createTaprootKnowledgeService({
      authorization: fixture.authorization,
      authorizedReader: fixture.authorizedReader,
      health: async () => {
        throw new Error('secret host detail');
      },
    });
    await expect(unavailable.health?.()).resolves.toBe(false);
  });
});
