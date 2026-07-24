import { WorkshopError } from './protocol/errors.js';

export const WORKSHOP_PRODUCER_KINDS = ['task', 'memory', 'prompt'] as const;
export type WorkshopProducerKind = (typeof WORKSHOP_PRODUCER_KINDS)[number];

export interface PublicCanonicalProducerHandle {
  readonly owner: '@gnolith/workshop';
  readonly installationId: string;
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  readonly handle: unknown;
}

const VERIFIED_PRODUCERS: unique symbol = Symbol('verified producers');

export interface VerifiedWorkshopProducerBinding {
  readonly [VERIFIED_PRODUCERS]: true;
  readonly installationId: string;
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  readonly handles: Readonly<Record<WorkshopProducerKind, unknown>>;
}

export interface WorkshopProducerBindingExpectation {
  installationId: string;
  connectionId: string;
  registrationFingerprint: string;
}

const verifiedBindings = new WeakSet<object>();

export function bindWorkshopProducerHandles(
  expectation: WorkshopProducerBindingExpectation,
  mappings: Readonly<
    Record<WorkshopProducerKind, PublicCanonicalProducerHandle>
  >,
): VerifiedWorkshopProducerBinding {
  validateIdentifier(expectation.installationId, 'installationId');
  validateIdentifier(expectation.connectionId, 'connectionId');
  validateFingerprint(expectation.registrationFingerprint);
  if (
    Object.keys(mappings).sort().join(',') !==
    [...WORKSHOP_PRODUCER_KINDS].sort().join(',')
  )
    throw invalid('Exactly three canonical producer mappings are required');
  const byKind = new Map<WorkshopProducerKind, unknown>();
  const opaqueHandles = new Set<unknown>();
  for (const publicKind of WORKSHOP_PRODUCER_KINDS) {
    const producer = mappings[publicKind];
    if (
      producer.owner !== '@gnolith/workshop' ||
      producer.installationId !== expectation.installationId ||
      producer.connectionId !== expectation.connectionId ||
      producer.registrationFingerprint !==
        expectation.registrationFingerprint ||
      producer.handle === null ||
      producer.handle === undefined ||
      opaqueHandles.has(producer.handle)
    )
      throw invalid('Canonical producer handle binding is invalid');
    opaqueHandles.add(producer.handle);
    byKind.set(publicKind, producer.handle);
  }
  const binding = Object.freeze({
    [VERIFIED_PRODUCERS]: true as const,
    installationId: expectation.installationId,
    connectionId: expectation.connectionId,
    registrationFingerprint: expectation.registrationFingerprint,
    handles: Object.freeze({
      task: byKind.get('task')!,
      memory: byKind.get('memory')!,
      prompt: byKind.get('prompt')!,
    }),
  });
  verifiedBindings.add(binding);
  return binding;
}

export function assertVerifiedWorkshopProducerBinding(
  binding: VerifiedWorkshopProducerBinding,
  expectation: WorkshopProducerBindingExpectation,
): void {
  if (
    !verifiedBindings.has(binding) ||
    binding.installationId !== expectation.installationId ||
    binding.connectionId !== expectation.connectionId ||
    binding.registrationFingerprint !== expectation.registrationFingerprint ||
    Object.keys(binding.handles).sort().join(',') !==
      [...WORKSHOP_PRODUCER_KINDS].sort().join(',')
  )
    throw invalid('Canonical producer binding is not verified');
}

function validateIdentifier(value: unknown, field: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    value.includes('\u0000')
  )
    throw invalid(`${field} is invalid`);
}

function validateFingerprint(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw invalid('registrationFingerprint is invalid');
}

function invalid(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
