import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalFilesystemResourceBlobPortsV1 } from '../src/backup.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('local filesystem ResourceBlob ports', () => {
  it('stages, verifies, commits, enumerates, opens, and detects collisions', async () => {
    const root = await temporaryRoot();
    const ports = await createLocalFilesystemResourceBlobPortsV1({ root });
    const bytes = new TextEncoder().encode('sealed resource payload');
    const descriptor = {
      referenceId: 'blob:canonical/one',
      resourceId: 'resource:one',
      revision: 1,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      mediaType: 'text/plain',
    };
    const stageId = await ports.restore.stage(
      descriptor,
      streamOf(bytes.slice(0, 7), bytes.slice(7)),
    );
    await ports.restore.verify(stageId);
    await expect(ports.restore.checkCollision(descriptor)).resolves.toBe(
      'absent',
    );
    await ports.restore.commit([stageId]);
    await expect(ports.restore.checkCollision(descriptor)).resolves.toBe(
      'identical',
    );
    await expect(
      ports.restore.checkCollision({ ...descriptor, revision: 2 }),
    ).resolves.toBe('conflict');
    await expect(ports.backup.enumerate(null, 10)).resolves.toEqual({
      items: [descriptor],
      cursor: null,
    });
    const opened = await ports.backup.open(descriptor.referenceId);
    expect(await consume(opened)).toEqual(bytes);
    await expect(
      ports.payloadStore.load({
        kind: 'blob-reference',
        referenceId: descriptor.referenceId,
        byteLength: descriptor.byteLength,
      }),
    ).resolves.toEqual(bytes);
    await expect(
      ports.payloadStore.load({
        kind: 'blob-reference',
        referenceId: descriptor.referenceId,
        byteLength: descriptor.byteLength + 1,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('supports canonical rebinds without treating reference IDs as paths', async () => {
    const root = await temporaryRoot();
    const ports = await createLocalFilesystemResourceBlobPortsV1({ root });
    const bytes = new TextEncoder().encode('opaque');
    const descriptor = {
      referenceId: '../../outside',
      resourceId: 'resource:two',
      revision: 2,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      mediaType: 'application/octet-stream',
    };
    const stageId = await ports.restore.stage(descriptor, streamOf(bytes));
    await ports.restore.verify(stageId);
    await ports.restore.rebind(stageId, '..\\..\\also-opaque');
    await ports.restore.commit([stageId]);
    const page = await ports.backup.enumerate(null, 1);
    expect(page.items[0]?.referenceId).toBe('..\\..\\also-opaque');
    expect((await lstat(join(root, 'objects'))).isDirectory()).toBe(true);
    await expect(lstat(join(root, '..', 'also-opaque'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on bounds, malformed cursors, unverified stages, and symlink objects', async () => {
    const root = await temporaryRoot();
    const ports = await createLocalFilesystemResourceBlobPortsV1({
      root,
      maxBlobBytes: 4,
    });
    const bytes = new TextEncoder().encode('five!');
    await expect(
      ports.restore.stage(
        {
          referenceId: 'blob:large',
          resourceId: 'resource:large',
          revision: 1,
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
          mediaType: 'text/plain',
        },
        streamOf(bytes),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(ports.backup.enumerate('***', 1)).rejects.toMatchObject({
      code: 'validation_failed',
    });

    const small = bytes.slice(0, 4);
    const descriptor = {
      referenceId: 'blob:small',
      resourceId: 'resource:small',
      revision: 1,
      byteLength: small.byteLength,
      sha256: sha256(small),
      mediaType: 'text/plain',
    };
    const stageId = await ports.restore.stage(descriptor, streamOf(small));
    await expect(ports.restore.commit([stageId])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await ports.restore.verify(stageId);
    await ports.restore.commit([stageId]);
    const object = join(root, 'objects', descriptor.sha256);
    const target = join(root, 'target');
    await readFile(object);
    await rm(object);
    try {
      await symlink(target, object, 'file');
    } catch {
      return;
    }
    await expect(
      ports.backup.open(descriptor.referenceId),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `workshop-blobs-${randomUUID()}-`));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function consume(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  reader.releaseLock();
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
