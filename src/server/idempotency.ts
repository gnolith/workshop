import { WorkshopError } from '../protocol/errors.js';
import type { D1DatabaseLike } from './database.js';
import { requiredText } from './validation.js';

export type WorkshopReceiptOperation =
  | 'memory.upsert'
  | 'memory.delete'
  | 'prompt.create'
  | 'prompt.update'
  | 'prompt.delete';

export interface WorkshopOperationReceiptBinding {
  installationId: string;
  principalId: string;
  operation: WorkshopReceiptOperation;
  idempotencyKey: string;
}

export interface WorkshopPreparedOperationReceipt {
  requestDigest: string;
  replay: { subjectId: string; response: unknown } | null;
}

export async function prepareWorkshopOperationReceipt(
  db: D1DatabaseLike,
  binding: WorkshopOperationReceiptBinding,
  request: unknown,
): Promise<WorkshopPreparedOperationReceipt> {
  const idempotencyKey = requiredText(
    binding.idempotencyKey,
    'idempotencyKey',
    256,
  );
  const requestDigest = await digestWorkshopOperationRequest(request);
  const row = await db
    .prepare(
      `SELECT subject_id, request_digest, response_json
       FROM workshop_operation_receipts
       WHERE installation_id = ? AND principal_id = ?
         AND operation = ? AND idempotency_key = ?`,
    )
    .bind(
      binding.installationId,
      binding.principalId,
      binding.operation,
      idempotencyKey,
    )
    .first<{
      subject_id: string;
      request_digest: string;
      response_json: string;
    }>();
  if (!row) return { requestDigest, replay: null };
  if (row.request_digest !== requestDigest)
    throw new WorkshopError(
      'conflict',
      'Idempotency key was used for another mutation',
      409,
    );
  let response: unknown;
  try {
    response = JSON.parse(row.response_json);
  } catch {
    throw new WorkshopError(
      'internal_error',
      'Idempotency receipt is invalid',
      500,
    );
  }
  return {
    requestDigest,
    replay: { subjectId: row.subject_id, response },
  };
}

export async function waitForWorkshopOperationReceipt(
  db: D1DatabaseLike,
  binding: WorkshopOperationReceiptBinding,
  request: unknown,
): Promise<WorkshopPreparedOperationReceipt> {
  let prepared = await prepareWorkshopOperationReceipt(db, binding, request);
  for (let attempt = 0; !prepared.replay && attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5 * (attempt + 1));
    });
    prepared = await prepareWorkshopOperationReceipt(db, binding, request);
  }
  return prepared;
}

export function workshopOperationReceiptStatement(
  binding: WorkshopOperationReceiptBinding,
  requestDigest: string,
  subjectId: string,
  response: unknown,
  createdAt: string,
  resultingRevision: number,
  eventId: string,
): { sql: string; values: readonly unknown[] } {
  const successfulMutation =
    binding.operation === 'memory.delete' ||
    binding.operation === 'memory.upsert'
      ? `SELECT 1 FROM workshop_memories
         WHERE installation_id = ? AND slug = ? AND revision = ?
           AND search_event_id = ?`
      : `SELECT 1 FROM workshop_prompts
         WHERE installation_id = ? AND id = ? AND revision = ?
           AND search_event_id = ?`;
  return {
    sql: `INSERT INTO workshop_operation_receipts
       (installation_id, principal_id, operation, idempotency_key,
        subject_id, request_digest, response_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (${successfulMutation})`,
    values: [
      binding.installationId,
      binding.principalId,
      binding.operation,
      binding.idempotencyKey,
      subjectId,
      requestDigest,
      JSON.stringify(response),
      createdAt,
      binding.installationId,
      subjectId,
      resultingRevision,
      eventId,
    ],
  };
}

export async function digestWorkshopOperationRequest(
  request: unknown,
): Promise<string> {
  return sha256(stableJson(request));
}

function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (entry: unknown): unknown => {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean'
    )
      return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry))
        throw new WorkshopError(
          'validation_failed',
          'Idempotent mutation input is invalid',
          400,
        );
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry !== 'object')
      throw new WorkshopError(
        'validation_failed',
        'Idempotent mutation input is invalid',
        400,
      );
    if (seen.has(entry))
      throw new WorkshopError(
        'validation_failed',
        'Idempotent mutation input is cyclic',
        400,
      );
    seen.add(entry);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(entry).sort()) {
      const child = (entry as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = normalize(child);
    }
    seen.delete(entry);
    return output;
  };
  return JSON.stringify(normalize(value));
}

async function sha256(value: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ).toString('hex');
}
