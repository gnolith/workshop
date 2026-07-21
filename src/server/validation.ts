import { WorkshopError } from '../protocol/errors.js';
import type { ContextQuery } from '../protocol/tasks.js';
import type { WorkshopLimits } from './limits.js';

const encoder = new TextEncoder();
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function requiredText(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validation(`${field} is required`, { field });
  }
  const normalized = value.trim();
  if (encoder.encode(normalized).byteLength > maxBytes) {
    throw new WorkshopError('limit_exceeded', `${field} is too large`, 413, {
      field,
      maxBytes,
    });
  }
  return normalized;
}

export function optionalText(
  value: unknown,
  field: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, field, maxBytes);
}

export function memorySlug(value: unknown): string {
  if (typeof value !== 'string' || !SLUG.test(value) || value.length > 96) {
    throw validation(
      'Memory slug must be 1-96 lowercase alphanumeric characters separated by hyphens',
      { field: 'slug' },
    );
  }
  return value;
}

export function memorySlugs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw validation('memorySlugs must be an array', { field: 'memorySlugs' });
  }
  return [...new Set(value.map(memorySlug))];
}

export function contextQueries(
  value: unknown,
  limits: WorkshopLimits,
): ContextQuery[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw validation('contextQueries must be an array', {
      field: 'contextQueries',
    });
  }
  if (value.length > limits.maxContextQueries) {
    throw new WorkshopError('limit_exceeded', 'Too many context queries', 413, {
      field: 'contextQueries',
      max: limits.maxContextQueries,
    });
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw validation('Context query must be an object', {
        queryIndex: index,
      });
    }
    const record = item as Record<string, unknown>;
    const sparql = requiredText(
      record.sparql,
      `contextQueries[${index}].sparql`,
      limits.maxQueryBytes,
    );
    const label = optionalText(
      record.label,
      `contextQueries[${index}].label`,
      256,
    );
    return { ...(label ? { label } : {}), sparql };
  });
}

export function pageLimit(value: unknown, limits: WorkshopLimits): number {
  if (value === undefined) return limits.defaultPageSize;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > limits.maxPageSize
  ) {
    throw validation(`limit must be between 1 and ${limits.maxPageSize}`, {
      field: 'limit',
    });
  }
  return parsed;
}

export function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw validation(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

export function validation(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): WorkshopError {
  return new WorkshopError('validation_failed', message, 400, details);
}
