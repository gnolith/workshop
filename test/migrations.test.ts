import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WORKSHOP_SCHEMA_VERSION,
  workshopMigrations,
} from '../src/migrations.js';

describe('migration artifact integrity', () => {
  it('keeps the embedded migration byte-equivalent to the canonical SQL file', () => {
    expect(WORKSHOP_SCHEMA_VERSION).toBe(workshopMigrations.length);
    for (const migration of workshopMigrations) {
      const file = readFileSync(`migrations/${migration.id}.sql`, 'utf8')
        .replace(/\r\n/gu, '\n')
        .trim();
      expect(migration.sql).toBe(file);
      const digest = createHash('sha256').update(file).digest('hex');
      expect(migration.checksum).toBe(`sha256:${digest}`);
    }
  });

  it('keeps migration identifiers unique and monotonically ordered', () => {
    const ids = workshopMigrations.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });
});
