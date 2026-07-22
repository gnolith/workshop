import { Parser } from '@traqula/parser-sparql-1-1';
import { WorkshopError } from '../protocol/errors.js';
import type { SparqlValidationResult } from '../protocol/sparql.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';
import { requiredText } from './validation.js';

export interface ContextQueryValidatorOptions {
  limits?: Partial<WorkshopLimits>;
  allowService?: (iri: URL) => boolean | Promise<boolean>;
  observe?: ObserveWorkshop;
}

/** Static parser/policy validation only. It owns no graph execution port. */
export class ContextQueryValidator {
  readonly #limits: WorkshopLimits;
  readonly #parser = new Parser();

  constructor(private readonly options: ContextQueryValidatorOptions = {}) {
    this.#limits = resolveLimits(options.limits);
  }

  async validate(queryValue: unknown): Promise<SparqlValidationResult> {
    return observed(
      this.options.observe,
      { operation: 'sparql.validate' },
      async () => {
        const query = requiredText(
          queryValue,
          'sparql',
          this.#limits.maxQueryBytes,
        );
        let parsed: unknown;
        try {
          parsed = this.#parser.parse(query);
        } catch (error) {
          throw new WorkshopError(
            'query_rejected',
            error instanceof Error ? error.message : 'SPARQL parse failed',
            400,
            { reason: 'parse' },
          );
        }
        const root = parsed as Record<string, unknown>;
        if (root.type !== 'query') {
          throw new WorkshopError(
            'query_rejected',
            'Only read-only SPARQL queries are allowed',
            400,
            { reason: 'update' },
          );
        }
        const queryType =
          typeof root.subType === 'string' ? root.subType.toUpperCase() : '';
        if (!['SELECT', 'ASK', 'CONSTRUCT', 'DESCRIBE'].includes(queryType)) {
          throw new WorkshopError(
            'query_rejected',
            `SPARQL operation ${queryType || 'unknown'} is not allowed`,
          );
        }
        for (const target of collectServiceTargets(parsed)) {
          if (
            !target ||
            !this.options.allowService ||
            !(await this.options.allowService(new URL(target)))
          ) {
            throw new WorkshopError(
              'query_rejected',
              'Federated SERVICE target is not allowed',
              403,
              { target: target ?? 'dynamic' },
            );
          }
        }
        return { valid: true, operation: 'query', queryType, warnings: [] };
      },
    );
  }
}

function collectServiceTargets(value: unknown): Array<string | null> {
  const targets: Array<string | null> = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (record.type === 'pattern' && record.subType === 'service') {
      const name = record.name as Record<string, unknown> | undefined;
      targets.push(
        name?.type === 'term' &&
          name.subType === 'namedNode' &&
          typeof name.value === 'string'
          ? name.value
          : null,
      );
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return targets;
}
