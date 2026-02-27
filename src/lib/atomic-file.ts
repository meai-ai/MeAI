/**
 * Atomic file operations — prevents data corruption from partial writes
 * and concurrent read-modify-write races.
 *
 * - readJsonSafe: read with fallback on parse error
 * - writeJsonAtomic: write to .tmp then rename (atomic on POSIX)
 * - withFileLock: in-process mutex serializing read-modify-write
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Safely read and parse a JSON file.
 * Returns `fallback` if file doesn't exist or fails to parse.
 */
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomically write JSON to a file.
 * Writes to a `.tmp` sibling first, then renames (atomic on POSIX).
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * In-process file lock — serializes read-modify-write for a given path.
 * Uses a Map of Promises keyed by resolved file path.
 */
const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  filePath: string,
  fn: (current: T) => T,
  fallback: T,
): Promise<T> {
  const resolved = path.resolve(filePath);

  // Chain onto any existing lock for this path
  const prev = locks.get(resolved) ?? Promise.resolve();

  let releaseLock: () => void;
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(resolved, nextLock);

  // Wait for previous operation on this file to complete
  await prev;

  try {
    const current = readJsonSafe<T>(resolved, fallback);
    const updated = fn(current);
    writeJsonAtomic(resolved, updated);
    return updated;
  } finally {
    releaseLock!();
    // Clean up if we're the last in the chain
    if (locks.get(resolved) === nextLock) {
      locks.delete(resolved);
    }
  }
}
