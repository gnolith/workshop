export interface D1ResultLike<T = unknown> {
  success?: boolean;
  meta?: Readonly<Record<string, unknown>>;
  results: T[];
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
  exec?(sql: string): Promise<unknown>;
}

/** Runtime-neutral persistence port implemented by D1 and SQLite adapters. */
export type WorkshopPersistence = D1DatabaseLike;
