import { describe, expect, it } from 'vitest';
import { SparqlService } from '../src/server/sparql.js';

describe('SPARQL execution bounds', () => {
  it('clamps a non-compliant host executor and reports truncation', async () => {
    const service = new SparqlService({
      execute: async () => ({
        type: 'bindings',
        data: [{ id: 1 }, { id: 2 }, { id: 3 }],
        truncated: false,
      }),
    });
    await expect(
      service.query('SELECT * WHERE { ?s ?p ?o }', { resultLimit: 2 }),
    ).resolves.toMatchObject({
      data: [{ id: 1 }, { id: 2 }],
      count: 3,
      truncated: true,
    });
  });

  it('rejects oversized result payloads even within the row limit', async () => {
    const service = new SparqlService({
      limits: { maxResultBytes: 64 },
      execute: async () => ({
        type: 'bindings',
        data: [{ value: 'x'.repeat(1_000) }],
        truncated: false,
      }),
    });
    await expect(
      service.query('SELECT * WHERE { ?s ?p ?o }'),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});
