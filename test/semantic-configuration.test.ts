import type { SemanticSearchAdminV1 } from '@gnolith/taproot/search';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureWorkshopSemanticsV1,
  readWorkshopSemanticStatusV1,
  type ConfigureWorkshopSemanticsV1Input,
} from '../src/semantic-configuration.js';
import { createTestContext, TEST_AUTHORIZATION } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Workshop semantic configuration control plane', () => {
  it('persists a redacted revision/fingerprint receipt and replays exactly', async () => {
    const fixture = await createTestContext();
    cleanups.push(fixture.dispose);
    const configure = vi.fn(async () => undefined);
    const semantic = {
      configure,
      async select() {},
      async status() {
        return {
          configured: true,
          configurationCount: 1,
          state: 'configured',
          revision: 1,
          fingerprint: 'e'.repeat(64),
          ready: false,
          selectedConfigurationId: null,
          selectedReady: false,
          circuitOpen: false,
          plans: [],
        };
      },
    } as unknown as SemanticSearchAdminV1;
    const input = configuration();
    const dependencies = {
      db: fixture.db,
      installationId: TEST_AUTHORIZATION.installationId,
      semantic,
      authorization: TEST_AUTHORIZATION,
    };
    await expect(
      configureWorkshopSemanticsV1(input, dependencies),
    ).resolves.toEqual({
      version: 1,
      configurationId: 'semantic-local-v1',
      revision: 1,
      fingerprint: 'e'.repeat(64),
      state: 'configured',
      ready: false,
      replayed: false,
    });
    await expect(
      configureWorkshopSemanticsV1(input, dependencies),
    ).resolves.toMatchObject({ revision: 1, replayed: true });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(configure.mock.calls)).not.toContain('secret');
    await expect(
      readWorkshopSemanticStatusV1(
        fixture.db,
        TEST_AUTHORIZATION.installationId,
      ),
    ).resolves.toEqual({
      state: 'degraded',
      configured: true,
      revision: 1,
      fingerprint: 'e'.repeat(64),
      ready: false,
    });
    await expect(
      configureWorkshopSemanticsV1(
        {
          ...input,
          configuration: {
            ...input.configuration,
            provider: { ...input.configuration.provider, model: 'other-model' },
          },
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it('rejects unapproved private endpoints and missing administration authority', async () => {
    const fixture = await createTestContext();
    cleanups.push(fixture.dispose);
    const semantic = {
      configure: vi.fn(),
      select: vi.fn(),
      status: vi.fn(),
    } as unknown as SemanticSearchAdminV1;
    const input = configuration();
    await expect(
      configureWorkshopSemanticsV1(
        {
          ...input,
          configuration: {
            ...input.configuration,
            provider: {
              ...input.configuration.provider,
              allowPrivateEndpoint: false,
            },
          },
        },
        {
          db: fixture.db,
          installationId: TEST_AUTHORIZATION.installationId,
          semantic,
          authorization: TEST_AUTHORIZATION,
        },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });
    await expect(
      configureWorkshopSemanticsV1(input, {
        db: fixture.db,
        installationId: TEST_AUTHORIZATION.installationId,
        semantic,
        authorization: { ...TEST_AUTHORIZATION, capabilities: ['read'] },
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(semantic.configure).not.toHaveBeenCalled();
  });

  it('passes the exact provider POST endpoint through unchanged', async () => {
    const fixture = await createTestContext();
    cleanups.push(fixture.dispose);
    const configured = vi.fn(async () => undefined);
    const selected = vi.fn(async () => undefined);
    const semantic = {
      configure: configured,
      select: selected,
      async status() {
        return {
          configured: true,
          configurationCount: 1,
          state: 'building',
          revision: 1,
          fingerprint: 'a'.repeat(64),
          ready: false,
          selectedConfigurationId: 'semantic-openai-v1',
          selectedReady: false,
          circuitOpen: false,
          plans: [],
        };
      },
    } as unknown as SemanticSearchAdminV1;
    const input: ConfigureWorkshopSemanticsV1Input = {
      ...configuration(),
      idempotencyKey: 'semantic-openai-exact-v1',
      configuration: {
        ...configuration().configuration,
        id: 'semantic-openai-v1',
        name: 'Exact OpenAI endpoint',
        provider: {
          ...configuration().configuration.provider,
          kind: 'openai-compatible',
          endpoint: 'http://127.0.0.1:4111/v1/embeddings',
          model: 'text-embedding-test',
        },
      },
    };
    const dependencies = {
      db: fixture.db,
      installationId: TEST_AUTHORIZATION.installationId,
      semantic,
      authorization: TEST_AUTHORIZATION,
    };
    await configureWorkshopSemanticsV1(input, dependencies);
    expect(configured).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({
          endpoint: 'http://127.0.0.1:4111/v1/embeddings',
        }),
      }),
      expect.objectContaining({
        expectedRevision: 0,
        idempotencyKey: 'semantic-openai-exact-v1',
      }),
      TEST_AUTHORIZATION,
    );

    expect(selected).toHaveBeenCalledWith(
      'semantic-openai-v1',
      TEST_AUTHORIZATION,
    );
  });
});

function configuration(): ConfigureWorkshopSemanticsV1Input {
  return {
    version: 1,
    expectedRevision: 0,
    idempotencyKey: 'semantic-local-config-v1',
    configuration: {
      version: 1,
      id: 'semantic-local-v1',
      name: 'Local Ollama with SQLite',
      provider: {
        kind: 'ollama-compatible',
        endpoint: 'http://127.0.0.1:11434/api/embed',
        model: 'nomic-embed-text',
        dimensions: 768,
        metric: 'cosine',
        credentialSelector: null,
        allowPrivateEndpoint: true,
        redirectPolicy: 'error',
      },
      vector: { kind: 'sqlite' },
    },
  };
}
