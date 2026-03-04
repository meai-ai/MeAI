/**
 * Tests for atomic-file.ts — readJsonSafe, writeJsonAtomic, withFileLock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJsonSafe, writeJsonAtomic, withFileLock } from "./atomic-file.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readJsonSafe", () => {
  it("returns fallback when file does not exist", () => {
    const result = readJsonSafe(path.join(tmpDir, "missing.json"), { x: 1 });
    expect(result).toEqual({ x: 1 });
  });

  it("returns parsed JSON for valid file", () => {
    const filePath = path.join(tmpDir, "valid.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "test", count: 42 }));
    const result = readJsonSafe(filePath, {});
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("returns fallback for corrupt JSON", () => {
    const filePath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(filePath, "{ invalid json !!!");
    const result = readJsonSafe(filePath, { fallback: true });
    expect(result).toEqual({ fallback: true });
  });
});

describe("writeJsonAtomic", () => {
  it("creates parent directories if missing", () => {
    const filePath = path.join(tmpDir, "deep", "nested", "data.json");
    writeJsonAtomic(filePath, { hello: "world" });
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual({ hello: "world" });
  });

  it("writes valid JSON", () => {
    const filePath = path.join(tmpDir, "out.json");
    writeJsonAtomic(filePath, { items: [1, 2, 3] });
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ items: [1, 2, 3] });
  });

  it("does not leave .tmp file after write", () => {
    const filePath = path.join(tmpDir, "clean.json");
    writeJsonAtomic(filePath, { ok: true });
    expect(fs.existsSync(filePath + ".tmp")).toBe(false);
  });
});

describe("withFileLock", () => {
  it("serializes access to the same file", async () => {
    const filePath = path.join(tmpDir, "counter.json");
    writeJsonAtomic(filePath, { count: 0 });

    // Launch 5 concurrent increments
    const promises = Array.from({ length: 5 }, () =>
      withFileLock<{ count: number }>(
        filePath,
        (current) => ({ count: current.count + 1 }),
        { count: 0 },
      ),
    );
    await Promise.all(promises);

    const final = readJsonSafe<{ count: number }>(filePath, { count: -1 });
    expect(final.count).toBe(5);
  });

  it("allows parallel access to different files", async () => {
    const fileA = path.join(tmpDir, "a.json");
    const fileB = path.join(tmpDir, "b.json");
    writeJsonAtomic(fileA, { value: "a" });
    writeJsonAtomic(fileB, { value: "b" });

    const [resultA, resultB] = await Promise.all([
      withFileLock<{ value: string }>(fileA, (c) => ({ value: c.value + "!" }), { value: "" }),
      withFileLock<{ value: string }>(fileB, (c) => ({ value: c.value + "!" }), { value: "" }),
    ]);

    expect(resultA.value).toBe("a!");
    expect(resultB.value).toBe("b!");
  });
});
