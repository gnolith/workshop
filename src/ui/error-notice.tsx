import { WorkshopError } from '../protocol/errors.js';

export function WorkshopErrorNotice({ error }: { error: unknown }) {
  const normalized =
    error instanceof WorkshopError
      ? error
      : new WorkshopError(
          'internal_error',
          error instanceof Error ? error.message : 'Workshop request failed',
        );
  return (
    <div className="workshop-error" role="alert">
      <strong>{normalized.code.replace(/_/gu, ' ')}</strong>:{' '}
      {normalized.message}
      {normalized.code === 'conflict' ? (
        <span> Refresh current data before retrying.</span>
      ) : null}
    </div>
  );
}
