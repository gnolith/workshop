import {
  OPERATION_ROUTE_PREFIX,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from '../generated/operations.js';
import { WorkshopError } from './errors.js';

export interface WorkshopClientOptions {
  baseOrigin?: string;
  fetch?: typeof globalThis.fetch;
  accessToken?: () => string | null | Promise<string | null>;
}

export interface WorkshopCallOptions {
  signal?: AbortSignal;
}

export interface WorkshopClient {
  call<Name extends OperationName>(
    name: Name,
    input: OperationInput<Name>,
    options?: WorkshopCallOptions,
  ): Promise<OperationOutput<Name>>;
}

export function createWorkshopClient(
  options: WorkshopClientOptions = {},
): WorkshopClient {
  const transport = options.fetch ?? globalThis.fetch;
  const origin = normalizeOrigin(options.baseOrigin ?? '');

  return {
    async call<Name extends OperationName>(
      name: Name,
      input: OperationInput<Name>,
      callOptions?: WorkshopCallOptions,
    ): Promise<OperationOutput<Name>> {
      const token = await options.accessToken?.();
      if (token !== null && token !== undefined && !validToken(token))
        throw new WorkshopError(
          'validation_failed',
          'Access token is invalid',
          400,
        );
      const init: RequestInit = {
        method: 'POST',
        body: JSON.stringify(input),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      };
      const response = await transport(
        `${origin}${OPERATION_ROUTE_PREFIX}/${name}`,
        init,
      );
      const body = (await response.json().catch(() => null)) as
        | {
            error?: {
              code?: string;
              message?: string;
              requestId?: string;
              details?: Record<string, unknown>;
            };
          }
        | OperationOutput<Name>
        | null;
      if (!response.ok) {
        const error =
          body && typeof body === 'object' && 'error' in body
            ? body.error
            : undefined;
        throw new WorkshopError(
          (error?.code as ConstructorParameters<typeof WorkshopError>[0]) ??
            'internal_error',
          error?.message ?? `Workshop request failed (${response.status})`,
          response.status,
          {
            ...(error?.requestId ? { requestId: error.requestId } : {}),
            ...(error?.details ?? {}),
          },
        );
      }
      return body as OperationOutput<Name>;
    },
  };
}

function normalizeOrigin(value: string): string {
  if (!value) return '';
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  )
    throw new WorkshopError(
      'validation_failed',
      'baseOrigin must be an origin without credentials, query, or path',
      400,
    );
  return url.origin;
}

function validToken(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 16_384 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}
