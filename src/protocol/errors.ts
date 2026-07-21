export type WorkshopErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'query_rejected'
  | 'query_timeout'
  | 'cancelled'
  | 'dependency_unavailable'
  | 'internal_error';

export interface WorkshopErrorBody {
  code: WorkshopErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class WorkshopError extends Error {
  readonly name = 'WorkshopError';

  constructor(
    readonly code: WorkshopErrorCode,
    message: string,
    readonly status = statusForCode(code),
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }

  toJSON(): WorkshopErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function normalizeWorkshopError(error: unknown): WorkshopError {
  if (error instanceof WorkshopError) return error;
  return new WorkshopError('internal_error', 'Workshop operation failed', 500);
}

function statusForCode(code: WorkshopErrorCode): number {
  switch (code) {
    case 'bad_request':
    case 'validation_failed':
    case 'query_rejected':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'limit_exceeded':
      return 413;
    case 'cancelled':
      return 499;
    case 'query_timeout':
      return 504;
    case 'dependency_unavailable':
      return 503;
    default:
      return 500;
  }
}
