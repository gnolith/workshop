export type SparqlResultType = 'bindings' | 'boolean' | 'quads';

export interface SparqlQueryResult {
  type: SparqlResultType;
  data: unknown;
  count?: number;
  truncated: boolean;
  durationMs: number;
}

export interface SparqlValidationResult {
  valid: true;
  operation: 'query';
  queryType: string;
  warnings: string[];
}

export interface SparqlQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  resultLimit?: number;
}
