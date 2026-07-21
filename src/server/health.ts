import type { KnowledgeService } from '../protocol/knowledge.js';
import {
  expectedWorkshopIndexes,
  expectedWorkshopTables,
  WORKSHOP_SCHEMA_VERSION,
} from '../migrations.js';
import type { D1DatabaseLike } from './database.js';
import type { SparqlService } from './sparql.js';

export interface WorkshopHealth {
  status: 'ok' | 'degraded';
  schemaVersion: number | null;
  workshopVersion: string;
  checks: {
    d1: boolean;
    schema: boolean;
    taproot: boolean;
    diamond: boolean;
    mcp: boolean;
    compatibility: boolean;
  };
}

export interface WorkshopDiagnostics extends WorkshopHealth {
  tables: string[];
  indexes: string[];
  missingTables: string[];
  missingIndexes: string[];
  installedPackageVersion: string | null;
}

export interface HealthServiceOptions {
  db: D1DatabaseLike;
  sparql: SparqlService;
  knowledge: KnowledgeService;
  constructMcp?: () => unknown;
  compatible?: () => boolean | Promise<boolean>;
}

export class HealthService {
  constructor(private readonly options: HealthServiceOptions) {}

  async inspect(): Promise<WorkshopDiagnostics> {
    let d1: boolean;
    let schemaVersion: number | null = null;
    let installedPackageVersion: string | null = null;
    let tables: string[] = [];
    let indexes: string[] = [];
    try {
      const objects = await this.options.db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'workshop_%' ORDER BY name",
        )
        .all<{ name: string; type: 'table' | 'index' }>();
      d1 = objects.success;
      tables = (objects.results ?? [])
        .filter((entry) => entry.type === 'table')
        .map((entry) => entry.name);
      indexes = (objects.results ?? [])
        .filter((entry) => entry.type === 'index')
        .map((entry) => entry.name);
      const version = await this.options.db
        .prepare(
          'SELECT version, package_version FROM workshop_schema WHERE singleton = 1',
        )
        .first<{ version: number; package_version: string }>();
      schemaVersion = version?.version ?? null;
      installedPackageVersion = version?.package_version ?? null;
    } catch {
      d1 = false;
    }
    const missingTables = expectedWorkshopTables.filter(
      (table) => !tables.includes(table),
    );
    const missingIndexes = expectedWorkshopIndexes.filter(
      (index) => !indexes.includes(index),
    );
    const schema =
      schemaVersion === WORKSHOP_SCHEMA_VERSION &&
      missingTables.length === 0 &&
      missingIndexes.length === 0;
    const [taproot, diamond, mcp, hostCompatibility] = await Promise.all([
      this.options.knowledge.health?.().catch(() => false) ?? false,
      this.options.sparql
        .dryRun('ASK { }', { resultLimit: 1, timeoutMs: 2_000 })
        .then(
          () => true,
          () => false,
        ),
      Promise.resolve()
        .then(() => this.options.constructMcp?.())
        .then(
          () => true,
          () => false,
        ),
      Promise.resolve(this.options.compatible?.() ?? true).catch(() => false),
    ]);
    const compatibility =
      installedPackageVersion !== null &&
      /^0\.1\./u.test(installedPackageVersion) &&
      hostCompatibility;
    const checks = { d1, schema, taproot, diamond, mcp, compatibility };
    return {
      status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded',
      schemaVersion,
      workshopVersion: '0.1.1',
      checks,
      tables,
      indexes,
      missingTables: [...missingTables],
      missingIndexes: [...missingIndexes],
      installedPackageVersion,
    };
  }

  async publicHealth(): Promise<WorkshopHealth> {
    const diagnostics = await this.inspect();
    return {
      status: diagnostics.status,
      schemaVersion: diagnostics.schemaVersion,
      workshopVersion: diagnostics.workshopVersion,
      checks: diagnostics.checks,
    };
  }
}
