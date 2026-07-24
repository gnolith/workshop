import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type {
  ResourceBlobBackupPort,
  ResourceBlobDescriptor,
  ResourceBlobRestorePort,
} from '@gnolith/taproot/backup';
import type { PortableResourcePayloadStoreV1 } from '@gnolith/taproot';
import { WorkshopError } from './protocol/errors.js';

const MANIFEST_FORMAT = 'workshop-resource-blob-store-v1';
const MANIFEST_FILE = 'manifest.json';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export interface LocalFilesystemResourceBlobOptionsV1 {
  root: string;
  maxBlobBytes?: number;
  maxEntries?: number;
}

export interface LocalFilesystemResourceBlobPortsV1 {
  readonly backup: ResourceBlobBackupPort;
  readonly restore: ResourceBlobRestorePort;
  readonly payloadStore: PortableResourcePayloadStoreV1;
}

interface Stage {
  descriptor: ResourceBlobDescriptor;
  path: string;
  verified: boolean;
}

/**
 * Creates both Taproot blob ports over one Workshop-managed local store.
 * Callers never derive, receive, or supply an on-disk object path.
 */
export async function createLocalFilesystemResourceBlobPortsV1(
  options: LocalFilesystemResourceBlobOptionsV1,
): Promise<LocalFilesystemResourceBlobPortsV1> {
  const root = resolveRoot(options.root);
  const maxBlobBytes = boundedInteger(
    options.maxBlobBytes ?? 256 * 1024 * 1024,
    1,
    1024 * 1024 * 1024,
    'maxBlobBytes',
  );
  const maxEntries = boundedInteger(
    options.maxEntries ?? 100_000,
    1,
    1_000_000,
    'maxEntries',
  );
  await secureDirectory(root);
  const objects = join(root, 'objects');
  const staging = join(root, 'staging');
  await secureDirectory(objects);
  await secureDirectory(staging);
  const stages = new Map<string, Stage>();

  const readManifest = async (): Promise<
    Map<string, ResourceBlobDescriptor>
  > => {
    const path = join(root, MANIFEST_FILE);
    let bytes: Buffer;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw unsafeStore();
      if (stat.size > MAX_MANIFEST_BYTES) throw invalidManifest();
      bytes = await readFile(path);
    } catch (error) {
      if (isMissing(error)) return new Map();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invalidManifest();
    }
    if (!isRecord(value) || value.format !== MANIFEST_FORMAT)
      throw invalidManifest();
    if (!Array.isArray(value.items) || value.items.length > maxEntries)
      throw invalidManifest();
    const entries = new Map<string, ResourceBlobDescriptor>();
    for (const item of value.items) {
      const descriptor = normalizeDescriptor(item, maxBlobBytes);
      if (entries.has(descriptor.referenceId)) throw invalidManifest();
      entries.set(descriptor.referenceId, descriptor);
    }
    return entries;
  };

  const writeManifest = async (
    entries: Map<string, ResourceBlobDescriptor>,
  ): Promise<void> => {
    if (entries.size > maxEntries)
      throw new WorkshopError(
        'validation_failed',
        'Resource blob manifest entry limit exceeded',
        400,
      );
    const body = JSON.stringify({
      format: MANIFEST_FORMAT,
      items: [...entries.values()].sort((a, b) =>
        compareCodeUnits(a.referenceId, b.referenceId),
      ),
    });
    if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) throw invalidManifest();
    const temporary = join(root, `.manifest-${randomUUID()}.tmp`);
    await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(root, MANIFEST_FILE));
  };

  const backup: ResourceBlobBackupPort = {
    async enumerate(cursor, limit) {
      boundedInteger(limit, 1, 1000, 'limit');
      const after = decodeCursor(cursor);
      const entries = [...(await readManifest()).values()].sort((a, b) =>
        compareCodeUnits(a.referenceId, b.referenceId),
      );
      const page = entries
        .filter(({ referenceId }) => compareCodeUnits(referenceId, after) > 0)
        .slice(0, limit + 1);
      const items = page.slice(0, limit);
      return {
        items,
        cursor:
          page.length > limit && items.length > 0
            ? encodeCursor(items.at(-1)!.referenceId)
            : null,
      };
    },
    async open(referenceId, signal) {
      assertReferenceId(referenceId);
      if (signal?.aborted) throw signal.reason;
      const descriptor = (await readManifest()).get(referenceId);
      if (!descriptor)
        throw new WorkshopError('not_found', 'Resource blob not found', 404);
      const path = objectPath(objects, descriptor.sha256);
      const stat = await lstat(path).catch((error: unknown) => {
        if (isMissing(error))
          throw new WorkshopError(
            'dependency_unavailable',
            'Resource blob payload is unavailable',
            503,
          );
        throw error;
      });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== descriptor.byteLength
      )
        throw unsafeStore();
      return Readable.toWeb(
        createReadStream(path, signal ? { signal } : undefined),
      ) as ReadableStream<Uint8Array>;
    },
  };

  const restore: ResourceBlobRestorePort = {
    async stage(rawDescriptor, stream) {
      const descriptor = normalizeDescriptor(rawDescriptor, maxBlobBytes);
      const stageId = randomUUID();
      const path = join(staging, `${stageId}.blob`);
      const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
      try {
        const digest = createHash('sha256');
        let byteLength = 0;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw invalidBlob();
            byteLength += value.byteLength;
            if (byteLength > descriptor.byteLength || byteLength > maxBlobBytes)
              throw invalidBlob();
            digest.update(value);
            await writeChunk(output, value);
          }
        } finally {
          reader.releaseLock();
        }
        await closeWriter(output);
        if (
          byteLength !== descriptor.byteLength ||
          digest.digest('hex') !== descriptor.sha256
        )
          throw invalidBlob();
        stages.set(stageId, { descriptor, path, verified: false });
        return stageId;
      } catch (error) {
        output.destroy();
        await rm(path, { force: true });
        throw error;
      }
    },
    async verify(stageId) {
      const stage = requireStage(stages, stageId);
      const stat = await lstat(stage.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== stage.descriptor.byteLength
      )
        throw invalidBlob();
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(stage.path))
        digest.update(chunk as Buffer);
      if (digest.digest('hex') !== stage.descriptor.sha256) throw invalidBlob();
      stage.verified = true;
    },
    async checkCollision(rawDescriptor) {
      const descriptor = normalizeDescriptor(rawDescriptor, maxBlobBytes);
      const existing = (await readManifest()).get(descriptor.referenceId);
      if (!existing) return 'absent';
      return equalDescriptor(existing, descriptor) ? 'identical' : 'conflict';
    },
    rebind(stageId, canonicalReferenceId) {
      assertReferenceId(canonicalReferenceId);
      const stage = requireStage(stages, stageId);
      stage.descriptor = {
        ...stage.descriptor,
        referenceId: canonicalReferenceId,
      };
      return Promise.resolve();
    },
    async commit(stageIds) {
      if (new Set(stageIds).size !== stageIds.length)
        throw new WorkshopError(
          'validation_failed',
          'Duplicate blob stage',
          400,
        );
      const selected = stageIds.map((id) => requireStage(stages, id));
      if (selected.some(({ verified }) => !verified))
        throw new WorkshopError(
          'validation_failed',
          'Resource blob stage is not verified',
          400,
        );
      const entries = await readManifest();
      for (const stage of selected) {
        const existing = entries.get(stage.descriptor.referenceId);
        if (existing && !equalDescriptor(existing, stage.descriptor))
          throw new WorkshopError(
            'conflict',
            'Resource blob reference conflicts with existing content',
            409,
          );
      }
      for (const stage of selected) {
        const destination = objectPath(objects, stage.descriptor.sha256);
        try {
          const stat = await lstat(destination);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size !== stage.descriptor.byteLength
          )
            throw unsafeStore();
          await rm(stage.path, { force: true });
        } catch (error) {
          if (!isMissing(error)) throw error;
          await rename(stage.path, destination);
        }
        entries.set(stage.descriptor.referenceId, stage.descriptor);
      }
      await writeManifest(entries);
      for (const id of stageIds) stages.delete(id);
    },
    async rollback(stageIds) {
      await Promise.all(
        stageIds.map(async (id) => {
          const stage = stages.get(id);
          if (!stage) return;
          stages.delete(id);
          await rm(stage.path, { force: true });
        }),
      );
    },
  };

  const payloadStore: PortableResourcePayloadStoreV1 = {
    kind: 'taproot-resource-payload-store-v1',
    async load(reference, signal) {
      assertReferenceId(reference.referenceId);
      boundedInteger(reference.byteLength, 0, maxBlobBytes, 'byteLength');
      signal?.throwIfAborted();
      const descriptor = (await readManifest()).get(reference.referenceId);
      if (!descriptor)
        throw new WorkshopError('not_found', 'Resource blob not found', 404);
      if (descriptor.byteLength !== reference.byteLength) throw invalidBlob();
      const path = objectPath(objects, descriptor.sha256);
      const stat = await lstat(path).catch((error: unknown) => {
        if (isMissing(error))
          throw new WorkshopError(
            'dependency_unavailable',
            'Resource blob payload is unavailable',
            503,
          );
        throw error;
      });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== descriptor.byteLength
      )
        throw unsafeStore();
      const bytes = await readFile(path, signal ? { signal } : undefined);
      if (
        bytes.byteLength !== descriptor.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256
      )
        throw unsafeStore();
      return new Uint8Array(bytes);
    },
  };

  return { backup, restore, payloadStore };
}

function resolveRoot(value: string): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value))
    throw new WorkshopError(
      'validation_failed',
      'Resource blob root must be an absolute path',
      400,
    );
  return resolve(value);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    resolve(canonical).toLowerCase() !== resolve(path).toLowerCase()
  )
    throw unsafeStore();
}

function objectPath(objects: string, sha256: string): string {
  return join(objects, sha256);
}

function normalizeDescriptor(
  value: unknown,
  maxBlobBytes: number,
): ResourceBlobDescriptor {
  if (!isRecord(value)) throw invalidBlob();
  const descriptor = {
    referenceId: value.referenceId,
    resourceId: value.resourceId,
    revision: value.revision,
    byteLength: value.byteLength,
    sha256: value.sha256,
    mediaType: value.mediaType,
  };
  assertReferenceId(descriptor.referenceId);
  assertIdentifier(descriptor.resourceId, 'resourceId');
  boundedInteger(descriptor.revision, 1, Number.MAX_SAFE_INTEGER, 'revision');
  boundedInteger(descriptor.byteLength, 0, maxBlobBytes, 'byteLength');
  if (
    typeof descriptor.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
    typeof descriptor.mediaType !== 'string' ||
    descriptor.mediaType.length < 1 ||
    descriptor.mediaType.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(descriptor.mediaType)
  )
    throw invalidBlob();
  return descriptor as ResourceBlobDescriptor;
}

function assertReferenceId(value: unknown): asserts value is string {
  assertIdentifier(value, 'referenceId');
}

function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new WorkshopError(
      'validation_failed',
      `Resource blob ${field} is invalid`,
      400,
    );
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new WorkshopError(
      'validation_failed',
      `Resource blob ${field} is invalid`,
      400,
    );
  return value;
}

function requireStage(stages: Map<string, Stage>, stageId: string): Stage {
  if (typeof stageId !== 'string') throw invalidBlob();
  const stage = stages.get(stageId);
  if (!stage)
    throw new WorkshopError('not_found', 'Resource blob stage not found', 404);
  return stage;
}

function equalDescriptor(
  left: ResourceBlobDescriptor,
  right: ResourceBlobDescriptor,
): boolean {
  return (
    left.referenceId === right.referenceId &&
    left.resourceId === right.resourceId &&
    left.revision === right.revision &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType
  );
}

function encodeCursor(referenceId: string): string {
  return Buffer.from(referenceId, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): string {
  if (cursor === null) return '';
  if (
    typeof cursor !== 'string' ||
    cursor.length < 1 ||
    cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  )
    throw new WorkshopError('validation_failed', 'Blob cursor is invalid', 400);
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  assertReferenceId(value);
  if (encodeCursor(value) !== cursor)
    throw new WorkshopError('validation_failed', 'Blob cursor is invalid', 400);
  return value;
}

function writeChunk(output: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    output.write(chunk, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function closeWriter(output: WriteStream): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    output.end((error?: Error | null) =>
      error ? reject(error) : resolvePromise(),
    );
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function invalidBlob(): WorkshopError {
  return new WorkshopError(
    'validation_failed',
    'Resource blob payload or descriptor is invalid',
    400,
  );
}

function invalidManifest(): WorkshopError {
  return new WorkshopError(
    'dependency_unavailable',
    'Resource blob manifest is invalid',
    503,
  );
}

function unsafeStore(): WorkshopError {
  return new WorkshopError(
    'dependency_unavailable',
    'Resource blob store contains an unsafe filesystem object',
    503,
  );
}
