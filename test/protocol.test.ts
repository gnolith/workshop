import { describe, expect, it } from 'vitest';
import { createWorkshopClient, taskState, type Task } from '../src/protocol.js';
import { ContextQueryValidator } from '../src/server/sparql.js';
import { memorySlug, requiredText } from '../src/server/validation.js';

const base: Task = {
  id: '1',
  description: 'd',
  prompt: 'p',
  contextQueries: [],
  memorySlugs: [],
  claimed: false,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  installationId: 'installation:test',
  ownerPrincipalId: 'agent:test',
  workspaceId: 'workspace:test',
  visibility: {
    version: 1,
    clauses: [[{ kind: 'workspace', workspaceId: 'workspace:test' }]],
  },
  authorizationRevision: 1,
};

describe('protocol and validation', () => {
  it('derives state without a redundant persisted status', () => {
    expect(taskState(base)).toBe('unclaimed');
    expect(taskState({ ...base, claimed: true })).toBe('claimed');
    expect(taskState({ ...base, completedAt: base.updatedAt })).toBe(
      'completed',
    );
    expect(
      taskState({
        ...base,
        completedAt: base.updatedAt,
        archivedAt: base.updatedAt,
      }),
    ).toBe('archived');
  });

  it('validates bounded text and memory slugs', () => {
    expect(requiredText(' value ', 'field', 10)).toBe('value');
    expect(memorySlug('archive-navigation')).toBe('archive-navigation');
    expect(() => memorySlug('Bad Slug')).toThrow(/slug/iu);
    expect(() => requiredText('12345', 'field', 4)).toThrow(/large/iu);
  });

  it('statically validates read-only stored graph queries', async () => {
    const service = new ContextQueryValidator();
    await expect(service.validate('ASK { }')).resolves.toMatchObject({
      valid: true,
      queryType: 'ASK',
    });
    await expect(
      service.validate('INSERT DATA { <x:a> <x:b> <x:c> }'),
    ).rejects.toMatchObject({ code: 'query_rejected' });
    await expect(
      service.validate(
        'SELECT * WHERE { SERVICE <https://remote.example/sparql> { ?s ?p ?o } }',
      ),
    ).rejects.toMatchObject({ code: 'query_rejected' });
  });

  it('builds authenticated browser requests and revision-conditional archives', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const client = createWorkshopClient({
      baseUrl: 'https://site.example',
      token: () => 'machine-token',
      fetch: async (input, init) => {
        captured = { input, ...(init ? { init } : {}) };
        return Response.json(base);
      },
    });
    await expect(
      client.tasks.archive(base.id, base.updatedAt),
    ).resolves.toEqual(base);
    expect(captured?.input).toBe('https://site.example/api/workshop/tasks/1');
    expect(new Headers(captured?.init?.headers).get('authorization')).toBe(
      'Bearer machine-token',
    );
    expect(new Headers(captured?.init?.headers).get('if-match')).toBe(
      base.updatedAt,
    );
    await client.tasks.archive(base.id, base.revision);
    expect(
      new Headers(captured?.init?.headers).get('x-workshop-revision'),
    ).toBe('1');
  });
});
