#!/usr/bin/env node
import {
  assembleWorkshopExecutable,
  runWorkshopBootstrap,
} from './executable.js';
import type { BootstrapWorkshopV1Input } from './bootstrap.js';
import { normalizeWorkshopError } from './protocol/errors.js';

const command = process.argv[2];

try {
  if (command === 'serve') {
    const configPath = exactOption(process.argv.slice(3), '--config');
    const service = await assembleWorkshopExecutable(configPath);
    const address = await service.start();
    process.stdout.write(
      `${JSON.stringify({ event: 'gnolith-workshop.started', ...address })}\n`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await service.stop();
        process.exit(0);
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        process.stderr.write(
          `${JSON.stringify({
            error: {
              code: normalized.code,
              message:
                normalized.code === 'internal_error'
                  ? 'gnolith-workshop shutdown failed'
                  : normalized.message,
            },
          })}\n`,
        );
        process.exit(1);
      }
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } else if (command === 'bootstrap-v1') {
    const options = parseOptions(process.argv.slice(3));
    assertOnlyOptions(options, [
      '--config',
      '--installation-id',
      '--base-iri',
      '--principal',
      '--workspace',
      '--credential-file',
      '--idempotency-key',
    ]);
    const receipt = await runWorkshopBootstrap(required(options, '--config'), {
      version: 1,
      installationId: required(options, '--installation-id'),
      baseIri: required(options, '--base-iri'),
      principalId: required(options, '--principal'),
      workspaceId: required(options, '--workspace'),
      credential: {
        kind: 'file',
        value: required(options, '--credential-file'),
      },
      idempotencyKey: required(options, '--idempotency-key'),
      profile: 'local-bearer-v1',
    } satisfies BootstrapWorkshopV1Input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    throw new Error(
      'Usage: gnolith-workshop serve --config <path> | bootstrap-v1 --config <path> --installation-id <id> --base-iri <iri> --principal <id> --workspace <id> --credential-file <path> --idempotency-key <key>',
    );
  }
} catch (error) {
  const normalized = normalizeWorkshopError(error);
  process.stderr.write(
    `${JSON.stringify({
      error: {
        code: normalized.code,
        message:
          normalized.code === 'internal_error'
            ? 'gnolith-workshop failed'
            : normalized.message,
      },
    })}\n`,
  );
  process.exitCode = 1;
}

function exactOption(args: readonly string[], name: string): string {
  const parsed = parseOptions(args);
  if (parsed.size !== 1) throw new Error(`Only ${name} is accepted`);
  return required(parsed, name);
}

function parseOptions(args: readonly string[]): Map<string, string> {
  if (args.length % 2 !== 0) throw new Error('Options require values');
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if (!name.startsWith('--') || !value || value.includes('\u0000'))
      throw new Error('Invalid command option');
    if (result.has(name)) throw new Error(`Duplicate option: ${name}`);
    result.set(name, value);
  }
  return result;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function assertOnlyOptions(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  for (const name of options.keys())
    if (!accepted.has(name)) throw new Error(`Unknown option: ${name}`);
}
