/**
 * State Schema — versioned state files with backward-compatible migration.
 *
 * Each state file gets wrapped in a VersionedState envelope:
 *   { schemaVersion: number, data: T, lastModified: number }
 *
 * readState() detects raw files (no schemaVersion), wraps them as v0,
 * and writes back. Zero data loss.
 *
 * Builds on existing readJsonSafe/writeJsonAtomic from atomic-file.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { createLogger } from "./logger.js";

const log = createLogger("state-schema");

// ── Types ────────────────────────────────────────────────────────────

export interface VersionedState<T> {
  schemaVersion: number;
  data: T;
  lastModified: number;
}

export interface StateSchema<T> {
  name: string;
  version: number;
  filePath: string;
  defaultData: () => T;
  migrate?: (data: unknown, fromVersion: number) => T;
  validate?: (data: T) => boolean;
}

export type DryRunRisk = "safe_wrap_only" | "needs_validation" | "legacy_shape_unrecognized";

export interface DryRunResult {
  filePath: string;
  name: string;
  currentVersion: number | null;  // null = raw file
  targetVersion: number;
  risk: DryRunRisk;
  exists: boolean;
}

// ── Registry ─────────────────────────────────────────────────────────

const registry = new Map<string, StateSchema<unknown>>();
let statePath = "";

// ── Init ─────────────────────────────────────────────────────────────

export function initStateSchema(dataPath: string): void {
  statePath = dataPath;
  log.info("initialized");
}

// ── Register ─────────────────────────────────────────────────────────

export function registerState<T>(schema: StateSchema<T>): void {
  registry.set(schema.name, schema as StateSchema<unknown>);
}

// ── Read ─────────────────────────────────────────────────────────────

export function readState<T>(schema: StateSchema<T>): T {
  const filePath = schema.filePath;

  if (!fs.existsSync(filePath)) {
    return schema.defaultData();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    // Already versioned
    if (raw && typeof raw === "object" && "schemaVersion" in raw && "data" in raw) {
      const versioned = raw as VersionedState<T>;

      // Same version — return as-is
      if (versioned.schemaVersion === schema.version) {
        return versioned.data;
      }

      // Needs migration
      if (schema.migrate && versioned.schemaVersion < schema.version) {
        const migrated = schema.migrate(versioned.data, versioned.schemaVersion);
        writeState(schema, migrated);
        log.info(`migrated ${schema.name}: v${versioned.schemaVersion} → v${schema.version}`);
        return migrated;
      }

      // Future version or no migrate — return data as-is
      return versioned.data;
    }

    // Raw file (v0) — wrap in envelope and write back
    const data = raw as T;
    writeState(schema, data);
    log.info(`wrapped raw file ${schema.name} → v${schema.version}`);
    return data;
  } catch (err) {
    log.warn(`failed to read ${schema.name}, using defaults`, err);
    return schema.defaultData();
  }
}

// ── Write ────────────────────────────────────────────────────────────

export function writeState<T>(schema: StateSchema<T>, data: T): void {
  const envelope: VersionedState<T> = {
    schemaVersion: schema.version,
    data,
    lastModified: Date.now(),
  };
  writeJsonAtomic(schema.filePath, envelope);
}

// ── Validate All ─────────────────────────────────────────────────────

export function validateAllStates(): void {
  for (const [name, schema] of registry) {
    try {
      if (!fs.existsSync(schema.filePath)) continue;

      const data = readState(schema);
      if (schema.validate && !schema.validate(data)) {
        log.warn(`validation failed for ${name}`);
      }
    } catch (err) {
      log.warn(`validation error for ${name}`, err);
    }
  }
}

// ── Dry Run Migration ────────────────────────────────────────────────

export function dryRunMigration(): DryRunResult[] {
  const results: DryRunResult[] = [];

  for (const [name, schema] of registry) {
    const exists = fs.existsSync(schema.filePath);
    let currentVersion: number | null = null;
    let risk: DryRunRisk = "safe_wrap_only";

    if (exists) {
      try {
        const raw = JSON.parse(fs.readFileSync(schema.filePath, "utf-8"));

        if (raw && typeof raw === "object" && "schemaVersion" in raw) {
          currentVersion = (raw as { schemaVersion: number }).schemaVersion;
          if (currentVersion === schema.version) {
            // Already at target — skip
            continue;
          }
          risk = schema.migrate ? "needs_validation" : "legacy_shape_unrecognized";
        } else {
          // Raw file — will be wrapped
          currentVersion = null;
          risk = "safe_wrap_only";

          // Check if the raw shape looks right
          if (schema.validate) {
            const valid = schema.validate(raw as unknown as ReturnType<typeof schema.defaultData>);
            if (!valid) risk = "legacy_shape_unrecognized";
          }
        }
      } catch {
        risk = "legacy_shape_unrecognized";
      }
    }

    results.push({
      filePath: schema.filePath,
      name,
      currentVersion,
      targetVersion: schema.version,
      risk,
      exists,
    });
  }

  return results;
}
