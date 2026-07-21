import { WorkshopError } from '../protocol/errors.js';

export interface CursorValue {
  updatedAt: string;
  id: string;
}

export function encodeCursor(value: CursorValue): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/gu, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

export function decodeCursor(
  value: string | undefined,
): CursorValue | undefined {
  if (!value) return undefined;
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CursorValue;
    if (!parsed.updatedAt || !parsed.id) throw new Error('invalid');
    return parsed;
  } catch {
    throw new WorkshopError(
      'validation_failed',
      'Invalid pagination cursor',
      400,
      {
        field: 'cursor',
      },
    );
  }
}
