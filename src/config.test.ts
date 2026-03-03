import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, resolveHome } from "./config.js";

// ── resolveHome ─────────────────────────────────────────────────────

describe("resolveHome", () => {
  it("expands tilde to home directory", () => {
    const result = resolveHome("~/foo/bar");
    expect(result).toBe(path.join(os.homedir(), "foo/bar"));
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveHome("/absolute/path")).toBe("/absolute/path");
  });

  it("resolves relative paths against cwd", () => {
    const result = resolveHome("relative/path");
    expect(result).toBe(path.resolve("relative/path"));
  });
});

// ── ConfigSchema ────────────────────────────────────────────────────

const VALID_MINIMAL = {
  telegramBotToken: "123:ABC",
  allowedChatId: 12345,
  anthropicApiKey: "sk-ant-test",
};

describe("ConfigSchema", () => {
  it("accepts valid minimal config", () => {
    const result = ConfigSchema.safeParse(VALID_MINIMAL);
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional fields", () => {
    const result = ConfigSchema.safeParse(VALID_MINIMAL);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.model).toBe("claude-sonnet-4-6");
    expect(result.data.maxContextTokens).toBe(180_000);
    expect(result.data.compactionThreshold).toBe(0.8);
    expect(result.data.channel).toBe("telegram");
    expect(result.data.statePath).toBe("");
  });

  it("rejects missing required fields", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("telegramBotToken");
    expect(paths).toContain("allowedChatId");
    expect(paths).toContain("anthropicApiKey");
  });

  it("rejects invalid types", () => {
    const result = ConfigSchema.safeParse({
      ...VALID_MINIMAL,
      allowedChatId: "not-a-number",
    });
    expect(result.success).toBe(false);
  });

  it("requires openaiApiKey when conversationProvider is openai", () => {
    const result = ConfigSchema.safeParse({
      ...VALID_MINIMAL,
      conversationProvider: "openai",
      // no openaiApiKey
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const keyIssue = result.error.issues.find((i) => i.path.includes("openaiApiKey"));
    expect(keyIssue).toBeDefined();
  });

  it("passes when conversationProvider is openai and openaiApiKey is present", () => {
    const result = ConfigSchema.safeParse({
      ...VALID_MINIMAL,
      conversationProvider: "openai",
      openaiApiKey: "sk-openai-test",
    });
    expect(result.success).toBe(true);
  });

  it("does not require openaiApiKey when conversationProvider is anthropic", () => {
    const result = ConfigSchema.safeParse({
      ...VALID_MINIMAL,
      conversationProvider: "anthropic",
    });
    expect(result.success).toBe(true);
  });
});
