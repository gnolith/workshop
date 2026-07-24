import { WorkshopError } from '../protocol/errors.js';

const MEDIA_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'application/wasm',
  'font/woff2',
  'image/avif',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/css',
  'text/html; charset=utf-8',
]);
const RESERVED_PREFIXES = ['/mcp', '/health', '/api', '/.well-known'];
export const WORKSHOP_RECOMMENDED_ASSET_PREFIX = '/app' as const;

export interface WaystoneAssetManifest {
  format: 'waystone-assets-v1';
  files: readonly {
    path: string;
    sha256: string;
    bytes: number;
    mediaType: string;
    immutable: true;
  }[];
  entrypoint: string;
  manifestSha256: string;
}

export interface WaystoneAssetSource {
  read(path: string): Promise<{ bytes: Uint8Array; symlink: boolean } | null>;
}

export interface VerifiedWaystoneAssets {
  readonly prefix: string;
  readonly manifest: WaystoneAssetManifest;
  serve(pathname: string): Promise<Response | null>;
}

export async function verifyWaystoneAssetMount(input: {
  prefix: string;
  manifest: unknown;
  source: WaystoneAssetSource;
}): Promise<VerifiedWaystoneAssets> {
  const prefix = validateWorkshopAssetPrefix(input.prefix);
  const manifest = exactManifest(input.manifest);
  const withoutDigest = {
    format: manifest.format,
    files: manifest.files,
    entrypoint: manifest.entrypoint,
  };
  const manifestDigest = await sha256Hex(
    new TextEncoder().encode(canonicalize(withoutDigest)),
  );
  if (!constantTimeHex(manifestDigest, manifest.manifestSha256.toLowerCase()))
    throw invalidAssets('Waystone manifest digest mismatch');
  const paths = manifest.files.map(({ path }) => path);
  if (
    paths.some((path) => path !== normalizeAssetPath(path)) ||
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path)
  )
    throw invalidAssets(
      'Waystone asset paths must be normalized, unique, and sorted',
    );
  if (!paths.includes(manifest.entrypoint))
    throw invalidAssets('Waystone entrypoint is not in the manifest');

  const bytesByPath = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    if (
      file.immutable !== true ||
      !MEDIA_TYPES.has(file.mediaType) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw invalidAssets('Waystone file metadata is invalid');
    const loaded = await input.source.read(file.path);
    if (!loaded || loaded.symlink)
      throw invalidAssets('Waystone asset is missing or a symlink');
    if (
      loaded.bytes.byteLength !== file.bytes ||
      !constantTimeHex(await sha256Hex(loaded.bytes), file.sha256)
    )
      throw invalidAssets('Waystone asset bytes do not match the manifest');
    bytesByPath.set(file.path, loaded.bytes.slice());
  }

  return {
    prefix,
    manifest,
    serve(pathname) {
      if (!pathname.startsWith(`${prefix}/`) && pathname !== prefix)
        return Promise.resolve(null);
      let normalized: string;
      try {
        const suffix =
          pathname === prefix
            ? manifest.entrypoint
            : decodeURIComponent(pathname.slice(prefix.length + 1));
        normalized = normalizeAssetPath(suffix);
      } catch {
        return Promise.resolve(null);
      }
      const file = manifest.files.find(({ path }) => path === normalized);
      const bytes = bytesByPath.get(normalized);
      if (!file || !bytes) return Promise.resolve(null);
      return Promise.resolve(
        new Response(bytes.slice(), {
          headers: {
            'content-type': file.mediaType,
            'content-length': String(file.bytes),
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          },
        }),
      );
    },
  };
}

function exactManifest(value: unknown): WaystoneAssetManifest {
  if (
    !recordWithKeys(value, ['entrypoint', 'files', 'format', 'manifestSha256'])
  )
    throw invalidAssets('Waystone manifest shape is invalid');
  if (
    value.format !== 'waystone-assets-v1' ||
    !Array.isArray(value.files) ||
    typeof value.entrypoint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(String(value.manifestSha256))
  )
    throw invalidAssets('Waystone manifest metadata is invalid');
  const files = value.files.map((file) => {
    if (
      !recordWithKeys(file, [
        'bytes',
        'immutable',
        'mediaType',
        'path',
        'sha256',
      ]) ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      typeof file.bytes !== 'number' ||
      typeof file.mediaType !== 'string' ||
      file.immutable !== true
    )
      throw invalidAssets('Waystone file entry is invalid');
    return {
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mediaType: file.mediaType,
      immutable: true as const,
    };
  });
  return {
    format: 'waystone-assets-v1',
    files,
    entrypoint: value.entrypoint,
    manifestSha256: String(value.manifestSha256),
  };
}

export function validateWorkshopAssetPrefix(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/u.test(value) ||
    RESERVED_PREFIXES.some(
      (reserved) =>
        value === reserved ||
        value.startsWith(`${reserved}/`) ||
        reserved.startsWith(`${value}/`),
    )
  )
    throw invalidAssets('Static asset prefix is invalid or reserved');
  return value;
}

function normalizeAssetPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\u0000')
  )
    throw invalidAssets('Waystone asset path is invalid');
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  )
    throw invalidAssets('Waystone asset path is invalid');
  return segments.join('/');
}

function recordWithKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as object).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right))
    return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function invalidAssets(message: string): WorkshopError {
  return new WorkshopError('validation_failed', message, 400);
}
