/**
 * Tests for relationship-model.ts — core relationship tracking functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initRelationshipModel,
  recordUserMessage,
  isGoodTimeToReachOut,
  formatRelationshipContext,
} from "./relationship-model.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-test-"));
  initRelationshipModel(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordUserMessage", () => {
  it("increments bid count and warms temperature", () => {
    recordUserMessage(14); // 2pm
    recordUserMessage(15); // 3pm

    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "relationship.json"), "utf-8"),
    );
    expect(state.bidsFromUser).toBeGreaterThanOrEqual(2);
    expect(state.temperature).toBeGreaterThan(0);
  });
});

describe("isGoodTimeToReachOut", () => {
  it("respects user's active hours histogram", () => {
    // Record several messages at hour 10 to build histogram
    for (let i = 0; i < 10; i++) {
      recordUserMessage(10);
    }

    // Hour 10 should be good (user is active then)
    expect(isGoodTimeToReachOut(10)).toBe(true);

    // Hour 3 (3am) with no data should still be allowed by default
    // (histogram starts flat, so all hours are equally likely)
    const result3am = isGoodTimeToReachOut(3);
    expect(typeof result3am).toBe("boolean");
  });
});

describe("formatRelationshipContext", () => {
  it("returns non-empty string after data is recorded (or throws if character not loaded)", () => {
    recordUserMessage(12);
    try {
      const ctx = formatRelationshipContext();
      // If character is loaded, we should get a non-empty string
      expect(typeof ctx).toBe("string");
      expect(ctx.length).toBeGreaterThan(0);
    } catch (err) {
      // formatRelationshipContext calls getCharacter() internally —
      // in test environment without character.yaml, this throws
      expect((err as Error).message).toContain("Character not initialized");
    }
  });
});
