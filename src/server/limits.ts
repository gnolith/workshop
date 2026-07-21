export interface WorkshopLimits {
  maxDescriptionBytes: number;
  maxPromptBytes: number;
  maxResultBytes: number;
  maxMemoryBytes: number;
  maxContextQueries: number;
  maxQueryBytes: number;
  sparqlTimeoutMs: number;
  sparqlResultLimit: number;
  maxMcpRequestBytes: number;
  toolTimeoutMs: number;
  defaultPageSize: number;
  maxPageSize: number;
}

export const defaultWorkshopLimits: Readonly<WorkshopLimits> = {
  maxDescriptionBytes: 4_096,
  maxPromptBytes: 128 * 1024,
  maxResultBytes: 256 * 1024,
  maxMemoryBytes: 128 * 1024,
  maxContextQueries: 20,
  maxQueryBytes: 16 * 1024,
  sparqlTimeoutMs: 10_000,
  sparqlResultLimit: 1_000,
  maxMcpRequestBytes: 1024 * 1024,
  toolTimeoutMs: 30_000,
  defaultPageSize: 50,
  maxPageSize: 200,
};

export function resolveLimits(
  limits?: Partial<WorkshopLimits>,
): Readonly<WorkshopLimits> {
  return { ...defaultWorkshopLimits, ...limits };
}
