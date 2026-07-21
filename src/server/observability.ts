export type WorkshopOperation =
  | 'task.create'
  | 'task.update'
  | 'task.archive'
  | 'task.claim'
  | 'task.complete'
  | 'task.reset-claim'
  | 'memory.upsert'
  | 'sparql.validate'
  | 'sparql.dry-run'
  | 'sparql.query'
  | 'knowledge.call'
  | 'mcp.call'
  | 'authorization.failure';

export interface WorkshopObservation {
  operation: WorkshopOperation;
  outcome: 'success' | 'error';
  durationMs: number;
  principalId?: string;
  requestId?: string;
  taskId?: string;
  entityId?: string;
  revision?: number;
  rowsRead?: number;
  rowsWritten?: number;
  errorCode?: string;
}

export type ObserveWorkshop = (
  observation: WorkshopObservation,
) => void | Promise<void>;

export async function observeSafely(
  observe: ObserveWorkshop | undefined,
  observation: WorkshopObservation,
): Promise<void> {
  try {
    await observe?.(observation);
  } catch {
    // Telemetry must never change the outcome of a domain operation.
  }
}

export async function observed<T>(
  observe: ObserveWorkshop | undefined,
  base: Omit<WorkshopObservation, 'durationMs' | 'outcome'>,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await operation();
    const detail = observationDetail(result);
    await observeSafely(observe, {
      ...base,
      ...detail,
      outcome: 'success',
      durationMs: performance.now() - started,
    });
    return result;
  } catch (error) {
    await observeSafely(observe, {
      ...base,
      outcome: 'error',
      durationMs: performance.now() - started,
      ...(error && typeof error === 'object' && 'code' in error
        ? { errorCode: String(error.code) }
        : {}),
    });
    throw error;
  }
}

function observationDetail(value: unknown): Partial<WorkshopObservation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.entityId === 'string'
      ? { entityId: record.entityId }
      : {}),
    ...(typeof record.newRevision === 'number'
      ? { revision: record.newRevision }
      : {}),
  };
}
