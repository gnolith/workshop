import type { KnowledgeService } from '../protocol/knowledge.js';
import {
  expectedWorkshopIndexes,
  expectedWorkshopTables,
  WORKSHOP_SCHEMA_VERSION,
} from '../migrations.js';
import type { D1DatabaseLike } from './database.js';
import { inspectWorkshopAuthorizationReadiness } from './authorization-readiness.js';

export interface WorkshopHealth {
  status: 'ok' | 'degraded';
  schemaVersion: number | null;
  workshopVersion: string;
  checks: {
    /** Runtime-neutral persistence health. */
    persistence: boolean;
    /** @deprecated Use `persistence`. Retained for D1-host compatibility. */
    d1: boolean;
    schema: boolean;
    taproot: boolean;
    diamond: boolean;
    mcp: boolean;
    compatibility: boolean;
    authorization: boolean;
  };
}

export interface WorkshopDiagnostics extends WorkshopHealth {
  tables: string[];
  indexes: string[];
  missingTables: string[];
  missingIndexes: string[];
  installedPackageVersion: string | null;
  quarantinedTasks: number | null;
  quarantinedMemories: number | null;
}

export interface HealthServiceOptions {
  db: D1DatabaseLike;
  diamondHealth: () => boolean | Promise<boolean>;
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
    let quarantinedTasks: number | null = null;
    let quarantinedMemories: number | null = null;
    try {
      const objects = await this.options.db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'workshop_%' ORDER BY name",
        )
        .all<{ name: string; type: 'table' | 'index' }>();
      d1 = objects.success !== false;
      tables = (objects.results ?? [])
        .filter((entry) => entry.type === 'table')
        .map((entry) => entry.name);
      indexes = (objects.results ?? [])
        .filter((entry) => entry.type === 'index')
        .map((entry) => entry.name);
      const versions = await this.options.db
        .prepare(
          'SELECT singleton, version, package_version FROM workshop_schema ORDER BY singleton',
        )
        .all<{ singleton: number; version: number; package_version: string }>();
      const version =
        versions.results?.length === 1 && versions.results[0]?.singleton === 1
          ? versions.results[0]
          : undefined;
      schemaVersion = version?.version ?? null;
      installedPackageVersion = version?.package_version ?? null;
      const authorization = await inspectWorkshopAuthorizationReadiness(
        this.options.db,
      );
      quarantinedTasks = authorization.quarantinedTasks;
      quarantinedMemories = authorization.quarantinedMemories;
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
      Promise.resolve()
        .then(() => this.options.diamondHealth())
        .catch(() => false),
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
      /^0\.3\./u.test(installedPackageVersion) &&
      hostCompatibility;
    const persistence = d1;
    const checks = {
      persistence,
      d1: persistence,
      schema,
      taproot,
      diamond,
      mcp,
      compatibility,
      authorization: quarantinedTasks === 0 && quarantinedMemories === 0,
    };
    return {
      status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded',
      schemaVersion,
      workshopVersion: '0.3.0',
      checks,
      tables,
      indexes,
      missingTables: [...missingTables],
      missingIndexes: [...missingIndexes],
      installedPackageVersion,
      quarantinedTasks,
      quarantinedMemories,
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
