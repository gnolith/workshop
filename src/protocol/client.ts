import { WorkshopError } from './errors.js';
import type {
  MemoryFilters,
  MemoryPage,
  UpsertMemoryInput,
} from './memories.js';
import type {
  CreateTaskInput,
  Task,
  TaskFilters,
  TaskPacket,
  TaskPage,
  RevisionHistoryOptions,
  UpdateTaskInput,
} from './tasks.js';
import type { Memory } from './memories.js';
import type { MemoryRevision } from './memories.js';
import type { TaskRevision } from './tasks.js';
import type {
  CreatePromptInput,
  Prompt,
  PromptFilters,
  PromptPage,
  PromptRevision,
  UpdatePromptInput,
} from './prompts.js';
import type { SearchPage, SearchRequest } from '@gnolith/taproot';

export interface WorkshopClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  token?: () => string | null | Promise<string | null>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface HistoryRequestOptions
  extends RequestOptions, RevisionHistoryOptions {}

interface WorkshopRequestInit extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal | undefined;
}

export interface WorkshopClient {
  tasks: {
    list(filters?: TaskFilters, options?: RequestOptions): Promise<TaskPage>;
    search(filters?: TaskFilters, options?: RequestOptions): Promise<TaskPage>;
    get(id: string, options?: RequestOptions): Promise<Task>;
    getPacket(id: string, options?: RequestOptions): Promise<TaskPacket>;
    create(input: CreateTaskInput, options?: RequestOptions): Promise<Task>;
    update(
      id: string,
      input: UpdateTaskInput,
      options?: RequestOptions,
    ): Promise<Task>;
    archive(
      id: string,
      expectedRevision: number | string,
      options?: RequestOptions,
    ): Promise<Task>;
    claim(id: string, options?: RequestOptions): Promise<Task>;
    complete(
      id: string,
      result: string,
      options?: RequestOptions,
    ): Promise<Task>;
    history(
      id: string,
      options?: HistoryRequestOptions,
    ): Promise<TaskRevision[]>;
  };
  memories: {
    list(
      filters?: MemoryFilters,
      options?: RequestOptions,
    ): Promise<MemoryPage>;
    get(slug: string, options?: RequestOptions): Promise<Memory>;
    upsert(
      slug: string,
      input: UpsertMemoryInput,
      options?: RequestOptions,
    ): Promise<Memory>;
    delete?: (
      slug: string,
      expectedRevision: number,
      options?: RequestOptions,
    ) => Promise<void>;
    history(
      slug: string,
      options?: HistoryRequestOptions,
    ): Promise<MemoryRevision[]>;
  };
  prompts?: {
    list(
      filters?: PromptFilters,
      options?: RequestOptions,
    ): Promise<PromptPage>;
    get(id: string, options?: RequestOptions): Promise<Prompt>;
    create(input: CreatePromptInput, options?: RequestOptions): Promise<Prompt>;
    update(
      id: string,
      input: UpdatePromptInput,
      options?: RequestOptions,
    ): Promise<Prompt>;
    delete(
      id: string,
      expectedRevision: number,
      options?: RequestOptions,
    ): Promise<void>;
    history(
      id: string,
      options?: HistoryRequestOptions,
    ): Promise<PromptRevision[]>;
  };
  search?: (
    request: SearchRequest,
    options?: RequestOptions,
  ) => Promise<SearchPage>;
  searchAdmin?: (
    input?: Readonly<Record<string, unknown>>,
    options?: RequestOptions,
  ) => Promise<unknown>;
}

export function createWorkshopClient(
  options: WorkshopClientOptions = {},
): WorkshopClient {
  const transport = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? '').replace(/\/$/u, '');

  const request = async <T>(
    path: string,
    init: WorkshopRequestInit = {},
  ): Promise<T> => {
    const token = await options.token?.();
    const { signal, ...requestInit } = init;
    const response = await transport(`${base}${path}`, {
      ...requestInit,
      ...(signal ? { signal } : {}),
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => null)) as
      | {
          error?: {
            code?: string;
            message?: string;
            details?: Record<string, unknown>;
          };
        }
      | T
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
        error?.details,
      );
    }
    return body as T;
  };

  const query = (filters: object | undefined) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size ? `?${params}` : '';
    return suffix;
  };

  return {
    tasks: {
      list: (filters, requestOptions) =>
        request(`/api/workshop/tasks${query(filters)}`, {
          signal: requestOptions?.signal,
        }),
      search: (filters, requestOptions) =>
        request(`/api/workshop/tasks${query(filters)}`, {
          signal: requestOptions?.signal,
        }),
      get: (id, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}`, {
          signal: requestOptions?.signal,
        }),
      getPacket: (id, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}/packet`, {
          signal: requestOptions?.signal,
        }),
      create: (input, requestOptions) =>
        request('/api/workshop/tasks', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: requestOptions?.signal,
        }),
      update: (id, input, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
          signal: requestOptions?.signal,
        }),
      archive: (id, expectedRevision, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers:
            typeof expectedRevision === 'number'
              ? { 'x-workshop-revision': String(expectedRevision) }
              : { 'if-match': expectedRevision },
          signal: requestOptions?.signal,
        }),
      claim: (id, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}/claim`, {
          method: 'POST',
          signal: requestOptions?.signal,
        }),
      complete: (id, result, requestOptions) =>
        request(`/api/workshop/tasks/${encodeURIComponent(id)}/complete`, {
          method: 'POST',
          body: JSON.stringify({ result }),
          signal: requestOptions?.signal,
        }),
      history: (id, requestOptions) =>
        request(
          `/api/workshop/tasks/${encodeURIComponent(id)}/history${query({ limit: requestOptions?.limit })}`,
          {
            signal: requestOptions?.signal,
          },
        ),
    },
    memories: {
      list: (filters, requestOptions) =>
        request(`/api/workshop/memories${query(filters)}`, {
          signal: requestOptions?.signal,
        }),
      get: (slug, requestOptions) =>
        request(`/api/workshop/memories/${encodeURIComponent(slug)}`, {
          signal: requestOptions?.signal,
        }),
      upsert: (slug, input, requestOptions) =>
        request(`/api/workshop/memories/${encodeURIComponent(slug)}`, {
          method: 'PUT',
          body: JSON.stringify(input),
          signal: requestOptions?.signal,
        }),
      delete: (slug, expectedRevision, requestOptions) =>
        request(`/api/workshop/memories/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
          headers: { 'x-workshop-revision': String(expectedRevision) },
          signal: requestOptions?.signal,
        }),
      history: (slug, requestOptions) =>
        request(
          `/api/workshop/memories/${encodeURIComponent(slug)}/history${query({ limit: requestOptions?.limit })}`,
          {
            signal: requestOptions?.signal,
          },
        ),
    },
    prompts: {
      list: (filters, requestOptions) =>
        request(`/api/workshop/prompts${query(filters)}`, {
          signal: requestOptions?.signal,
        }),
      get: (id, requestOptions) =>
        request(`/api/workshop/prompts/${encodeURIComponent(id)}`, {
          signal: requestOptions?.signal,
        }),
      create: (input, requestOptions) =>
        request('/api/workshop/prompts', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: requestOptions?.signal,
        }),
      update: (id, input, requestOptions) =>
        request(`/api/workshop/prompts/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
          signal: requestOptions?.signal,
        }),
      delete: (id, expectedRevision, requestOptions) =>
        request(`/api/workshop/prompts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'x-workshop-revision': String(expectedRevision) },
          signal: requestOptions?.signal,
        }),
      history: (id, requestOptions) =>
        request(
          `/api/workshop/prompts/${encodeURIComponent(id)}/history${query({ limit: requestOptions?.limit })}`,
          {
            signal: requestOptions?.signal,
          },
        ),
    },
    search: (searchRequest, requestOptions) =>
      request('/api/workshop/search', {
        method: 'POST',
        body: JSON.stringify(searchRequest),
        signal: requestOptions?.signal,
      }),
    searchAdmin: (input = {}, requestOptions) =>
      request('/api/workshop/search/admin', {
        method: Object.keys(input).length ? 'POST' : 'GET',
        ...(Object.keys(input).length ? { body: JSON.stringify(input) } : {}),
        signal: requestOptions?.signal,
      }),
  };
}
