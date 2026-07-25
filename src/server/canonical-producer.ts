import type {
  ExternalOwnerTransactionAdapterV1,
  RegisteredExternalProducerV1,
} from '@gnolith/taproot/search';
import type { AuthorizationContext } from '../protocol/authorization.js';
import { WorkshopError } from '../protocol/errors.js';
import type { D1DatabaseLike, D1ResultLike } from './database.js';

export interface WorkshopSearchDomainV1 {
  currentPredecessor(
    sourceId: string,
    context: AuthorizationContext,
  ): Promise<{ eventId: string; sequence: number }>;
  commitCanonicalMutation(
    input: WorkshopCanonicalSearchMutationV1,
  ): Promise<WorkshopCanonicalSearchMutationReceiptV1>;
  adopt(
    context: AuthorizationContext,
    input: { cursor?: string | null; limit: number },
  ): Promise<{ enumerated: number; adopted: number; cursor: string | null }>;
}

export interface WorkshopCanonicalSearchMutationV1 {
  context: AuthorizationContext;
  eventId: string;
  sourceId: string;
  operation: 'upsert' | 'delete';
  changeClass: string;
  sourceRevision: number;
  sourcePolicyRevision: number;
  predecessor: { eventId: string; sequence: number } | null;
  canonicalPostState: unknown;
  statements: readonly { sql: string; values: readonly unknown[] }[];
}

export interface WorkshopCanonicalSearchMutationReceiptV1 {
  eventId: string;
  authorizationRevision: number;
  searchGeneration: number;
  results: readonly D1ResultLike[];
}

export interface WorkshopCanonicalOwnerAdapterControllerV1 {
  readonly adapter: ExternalOwnerTransactionAdapterV1;
  bind(registered: RegisteredExternalProducerV1): WorkshopSearchDomainV1;
}

/**
 * Bridges Workshop-owned SQL into Taproot's exact owner-token transaction
 * boundary. Tokens are process-local identities and are consumed once.
 */
export function createWorkshopCanonicalOwnerAdapterV1(
  db: D1DatabaseLike,
): WorkshopCanonicalOwnerAdapterControllerV1 {
  const pending = new WeakMap<object, WorkshopCanonicalSearchMutationV1>();
  let bound = false;
  const adapter: ExternalOwnerTransactionAdapterV1 = {
    kind: 'taproot-external-owner-transaction-adapter-v1',
    prepare(ownerMutationToken) {
      if (!isObjectToken(ownerMutationToken)) throw invalidOwnerToken();
      const input = pending.get(ownerMutationToken);
      if (!input) throw invalidOwnerToken();
      pending.delete(ownerMutationToken);
      return Promise.resolve(
        input.statements.map(({ sql, values }) =>
          db.prepare(sql).bind(...values),
        ),
      );
    },
  };

  return {
    adapter,
    bind(registered) {
      if (bound)
        throw new WorkshopError(
          'validation_failed',
          'Workshop producer adapter is already bound',
          400,
        );
      bound = true;
      return {
        async currentPredecessor(sourceId) {
          const predecessor = await registered.currentPredecessor(sourceId);
          if (!predecessor)
            throw new WorkshopError(
              'forbidden',
              'Canonical predecessor is unavailable',
              403,
            );
          return predecessor;
        },
        async commitCanonicalMutation(input) {
          const token = {};
          pending.set(token, input);
          try {
            const participant = await registered.issuer.seal({
              sourceId: input.sourceId,
              sourceRevision: String(input.sourceRevision),
              operation: input.operation,
              predecessor: input.predecessor,
              ownerMutationToken: token,
            });
            const receipt = await registered.commit(participant);
            return {
              eventId: receipt.eventId,
              authorizationRevision: receipt.authorizationRevision,
              searchGeneration: receipt.generation,
              results: receipt.results as readonly D1ResultLike[],
            };
          } finally {
            pending.delete(token);
          }
        },
        adopt: (context, input) => registered.adopt(context, input),
      };
    },
  };
}

export async function commitWorkshopCanonicalSearchMutationV1(
  domain: WorkshopSearchDomainV1,
  input: WorkshopCanonicalSearchMutationV1,
): Promise<WorkshopCanonicalSearchMutationReceiptV1> {
  return domain.commitCanonicalMutation(input);
}

function isObjectToken(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function invalidOwnerToken(): WorkshopError {
  return new WorkshopError(
    'validation_failed',
    'Workshop owner mutation token is invalid or already consumed',
    400,
  );
}
