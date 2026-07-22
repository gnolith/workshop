import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { verifyTaprootRelease } from '../scripts/release-block.mjs';
import { assertPublishDryRunBoundary } from '../scripts/prepublish-check.mjs';

const predicateType = 'https://slsa.dev/provenance/v1';
const sourceCommit = '9b7eb5de694e6020ce8466e01687b8077fbf915c';
const sha512Bytes = Buffer.alloc(64, 0xab);
const sha512 = sha512Bytes.toString('hex');

describe('Workshop package release boundary', () => {
  const head = 'a'.repeat(40);
  const tag = 'v0.3.3';

  it('accepts a successful dry run only for the annotated tag at HEAD', () => {
    expect(
      assertPublishDryRunBoundary({
        status: 0,
        output:
          `@gnolith/taproot 0.3.0 public npm provenance verified\n` +
          `release artifact validated for ${tag} at ${head} (digest)\n`,
        tag,
        head,
        tagType: 'tag',
        tagCommit: head,
      }),
    ).toBe('tagged');
  });

  it('accepts an untagged dry-run failure only at the exact missing-tag boundary', () => {
    expect(
      assertPublishDryRunBoundary({
        status: 1,
        output:
          '@gnolith/taproot 0.3.0 public npm provenance verified\n' +
          `fatal: ambiguous argument 'refs/tags/${tag}': unknown revision or path not in the working tree.\n`,
        tag,
        head,
        tagType: null,
        tagCommit: null,
      }),
    ).toBe('untagged');
    expect(() =>
      assertPublishDryRunBoundary({
        status: 1,
        output: `fatal: refs/tags/${tag} resolves to the wrong commit\n`,
        tag,
        head,
        tagType: 'tag',
        tagCommit: 'b'.repeat(40),
      }),
    ).toThrow(/away from HEAD|not an annotated tag at HEAD/u);
    expect(() =>
      assertPublishDryRunBoundary({
        status: 1,
        output: `fatal: refs/tags/${tag} is lightweight\n`,
        tag,
        head,
        tagType: 'commit',
        tagCommit: head,
      }),
    ).toThrow(/not an annotated tag at HEAD/u);
    expect(() =>
      assertPublishDryRunBoundary({
        status: 1,
        output: `fatal: unrelated failure mentioning refs/tags/${tag}\n`,
        tag,
        head,
        tagType: null,
        tagCommit: null,
      }),
    ).toThrow(/exact missing Workshop/u);
  });

  it('binds the exact Taproot package digest and SLSA source identity', async () => {
    await expect(verifyFixture()).resolves.toMatchObject({
      packageName: '@gnolith/taproot',
      version: '0.3.0',
      sourceCommit,
    });
  });

  it.each([
    [
      'wrong statement type',
      (statement: Statement) => (statement._type = 'attacker'),
    ],
    [
      'wrong predicate',
      (statement: Statement) => (statement.predicateType = 'attacker'),
    ],
    [
      'wrong digest',
      (statement: Statement) => (statement.subject[0]!.digest.sha512 = '00'),
    ],
    [
      'extra subject',
      (statement: Statement) =>
        statement.subject.push(structuredClone(statement.subject[0]!)),
    ],
    [
      'wrong workflow',
      (statement: Statement) =>
        (statement.predicate.buildDefinition.externalParameters.workflow.repository =
          'https://github.com/attacker/not-taproot'),
    ],
    [
      'wrong dependency',
      (statement: Statement) =>
        (statement.predicate.buildDefinition.resolvedDependencies[0]!.uri =
          'git+https://attacker.invalid/not-taproot'),
    ],
  ])('rejects %s', async (_label, mutate) => {
    const fixture = createFixture();
    mutate(fixture.statement);
    await expect(verifyFixture(fixture)).rejects.toThrow();
  });

  it('rejects missing signatures and ambiguous provenance statements', async () => {
    const unsigned = createFixture();
    unsigned.attestation.attestations[0]!.bundle.dsseEnvelope.signatures = [];
    await expect(verifyFixture(unsigned)).rejects.toThrow(/signature/u);

    const ambiguous = createFixture();
    ambiguous.attestation.attestations.push(
      structuredClone(ambiguous.attestation.attestations[0]!),
    );
    await expect(verifyFixture(ambiguous)).rejects.toThrow(/exactly one/u);
  });
});

function createFixture() {
  const statement: Statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'pkg:npm/%40gnolith/taproot@0.3.0',
        digest: { sha512 },
      },
    ],
    predicateType,
    predicate: {
      buildDefinition: {
        buildType:
          'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/tags/v0.3.0',
            repository: 'https://github.com/gnolith/taproot',
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/gnolith/taproot@refs/tags/v0.3.0',
            digest: { gitCommit: sourceCommit },
          },
        ],
      },
    },
  };
  const attestation = {
    attestations: [
      {
        predicateType,
        bundle: {
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: encodeStatement(statement),
            signatures: [{ keyid: '', sig: 'trusted-registry-signature' }],
          },
        },
      },
    ],
  };
  const metadata = {
    name: '@gnolith/taproot',
    version: '0.3.0',
    dist: {
      integrity: `sha512-${sha512Bytes.toString('base64')}`,
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2ftaproot@0.3.0',
        provenance: { predicateType },
      },
    },
  };
  return { statement, attestation, metadata };
}

async function verifyFixture(fixture = createFixture()) {
  fixture.attestation.attestations[0]!.bundle.dsseEnvelope.payload =
    encodeStatement(fixture.statement);
  return verifyTaprootRelease({
    verifyPackage: async () => undefined,
    fetchImpl: async (url: URL) =>
      new Response(
        JSON.stringify(
          url.pathname.includes('/-/npm/v1/attestations/')
            ? fixture.attestation
            : fixture.metadata,
        ),
        { status: 200 },
      ),
  });
}

function encodeStatement(statement: Statement) {
  return Buffer.from(JSON.stringify(statement)).toString('base64');
}

interface Statement {
  _type: string;
  subject: Array<{
    name: string;
    digest: { sha512: string };
  }>;
  predicateType: string;
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: {
        workflow: { ref: string; repository: string; path: string };
      };
      resolvedDependencies: Array<{
        uri: string;
        digest: { gitCommit: string };
      }>;
    };
  };
}
