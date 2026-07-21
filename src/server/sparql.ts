import { Parser } from '@traqula/parser-sparql-1-1';
import { WorkshopError } from '../protocol/errors.js';
import type {
  SparqlQueryOptions,
  SparqlQueryResult,
  SparqlValidationResult,
} from '../protocol/sparql.js';
import type { WorkshopLimits } from './limits.js';
import { resolveLimits } from './limits.js';
import type { ObserveWorkshop } from './observability.js';
import { observed } from './observability.js';
import { requiredText } from './validation.js';

export type ExecuteSparql = (
  query: string,
  options: Required<Pick<SparqlQueryOptions, 'timeoutMs' | 'resultLimit'>> & {
    signal: AbortSignal;
  },
) => Promise<Omit<SparqlQueryResult, 'durationMs'>>;

export interface SparqlServiceOptions {
  execute: ExecuteSparql;
  limits?: Partial<WorkshopLimits>;
  allowService?: (iri: URL) => boolean | Promise<boolean>;
  observe?: ObserveWorkshop;
}

export class SparqlService {
  readonly #limits: WorkshopLimits;
  readonly #parser = new Parser();
  constructor(private readonly options: SparqlServiceOptions) {
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
        const services = collectServiceTargets(parsed);
        for (const target of services) {
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

  async dryRun(
    query: string,
    options: SparqlQueryOptions = {},
  ): Promise<SparqlQueryResult> {
    await this.validate(query);
    return observed(this.options.observe, { operation: 'sparql.dry-run' }, () =>
      this.#execute(query, {
        ...options,
        timeoutMs: Math.min(
          options.timeoutMs ?? this.#limits.sparqlTimeoutMs,
          5_000,
        ),
        resultLimit: Math.min(options.resultLimit ?? 1, 10),
      }),
    );
  }

  async query(
    query: string,
    options: SparqlQueryOptions = {},
  ): Promise<SparqlQueryResult> {
    await this.validate(query);
    return observed(this.options.observe, { operation: 'sparql.query' }, () =>
      this.#execute(query, options),
    );
  }

  async #execute(
    query: string,
    options: SparqlQueryOptions,
  ): Promise<SparqlQueryResult> {
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#limits.sparqlTimeoutMs,
      this.#limits.sparqlTimeoutMs,
    );
    const resultLimit = Math.min(
      options.resultLimit ?? this.#limits.sparqlResultLimit,
      this.#limits.sparqlResultLimit,
    );
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const started = performance.now();
    try {
      const result = await this.options.execute(query, {
        signal: controller.signal,
        timeoutMs,
        resultLimit,
      });
      const bounded = boundResult(result, resultLimit);
      if (
        new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
        this.#limits.maxResultBytes
      ) {
        throw new WorkshopError(
          'limit_exceeded',
          'SPARQL result exceeded the configured response-size limit',
        );
      }
      return { ...bounded, durationMs: performance.now() - started };
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.signal?.aborted) {
          throw new WorkshopError('cancelled', 'SPARQL query was cancelled');
        }
        throw new WorkshopError('query_timeout', 'SPARQL query timed out');
      }
      if (error instanceof WorkshopError) throw error;
      throw new WorkshopError(
        'dependency_unavailable',
        'SPARQL execution failed',
        503,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

function boundResult(
  result: Omit<SparqlQueryResult, 'durationMs'>,
  resultLimit: number,
): Omit<SparqlQueryResult, 'durationMs'> {
  if (result.type === 'boolean') return result;
  if (!Array.isArray(result.data)) {
    throw new WorkshopError(
      'dependency_unavailable',
      'SPARQL executor returned an invalid result shape',
      503,
    );
  }
  return {
    ...result,
    data: result.data.slice(0, resultLimit),
    count: result.count ?? result.data.length,
    truncated: result.truncated || result.data.length > resultLimit,
  };
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
