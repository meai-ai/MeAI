import { describe, it, expect } from "vitest";
import type { Skill, AppConfig } from "../types.js";
import {
  extractKeywords,
  selectSkills,
  extractRecentlyUsedSkills,
  getAlwaysOnSkills,
} from "./skill-router.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeSkill(name: string, content = `# ${name}\nA skill for ${name}.`): Skill {
  return { name, content, hasTools: false };
}

// ── extractKeywords ─────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts keywords from skill name with high weight", () => {
    const skill = makeSkill("web-search", "# Web Search\nSearch the web.\n## When to use\nUse when user wants to find info online.");
    const kw = extractKeywords(skill);
    expect(kw.has("web")).toBe(true);
    expect(kw.has("search")).toBe(true);
    // Name tokens should have highest weight (5.0)
    expect(kw.get("web")!).toBeGreaterThanOrEqual(5.0);
  });

  it("filters out stop words", () => {
    const skill = makeSkill("test", "# Test\nThis is a test of the system.");
    const kw = extractKeywords(skill);
    expect(kw.has("the")).toBe(false);
    expect(kw.has("is")).toBe(false);
    expect(kw.has("of")).toBe(false);
  });

  it("gives higher weight to 'When to use' section", () => {
    const skill = makeSkill("photo", "# Photo\nTake photos.\n## When to use\nUse for camera selfie portrait.");
    const kw = extractKeywords(skill);
    // "selfie" only appears in When to use (weight 3.0) + rest (0.5) = 3.5
    // "photo" appears in name (5.0) + title (2.0) + rest (0.5) = 7.5
    expect(kw.get("photo")!).toBeGreaterThan(kw.get("selfie")!);
  });
});

// ── getAlwaysOnSkills ───────────────────────────────────────────────

describe("getAlwaysOnSkills", () => {
  it("returns base skills without config", () => {
    const skills = getAlwaysOnSkills();
    expect(skills.has("claude-code")).toBe(true);
    expect(skills.has("datetime")).toBe(true);
    expect(skills.has("weather")).toBe(true);
    expect(skills.has("web-search")).toBe(true);
    expect(skills.has("x-browser")).toBe(true);
    expect(skills.has("selfie")).toBe(false);
    expect(skills.has("tts")).toBe(false);
  });

  it("includes selfie when falApiKey is present", () => {
    const skills = getAlwaysOnSkills({ falApiKey: "fal-test" } as AppConfig);
    expect(skills.has("selfie")).toBe(true);
    expect(skills.has("tts")).toBe(false);
  });

  it("includes tts when fishAudioApiKey is present", () => {
    const skills = getAlwaysOnSkills({ fishAudioApiKey: "fish-test" } as AppConfig);
    expect(skills.has("tts")).toBe(true);
    expect(skills.has("selfie")).toBe(false);
  });
});

// ── selectSkills ────────────────────────────────────────────────────

describe("selectSkills", () => {
  // Build enough skills to exceed threshold and trigger filtering
  const alwaysOnNames = ["claude-code", "datetime", "weather", "web-search", "x-browser"];
  const allSkills = [
    ...alwaysOnNames.map((n) => makeSkill(n)),
    makeSkill("selfie", "# Selfie\nGenerate AI selfie images."),
    makeSkill("tts", "# TTS\nText to speech voice synthesis."),
    makeSkill("stock-tracker", "# Stock Tracker\nCheck stock prices and portfolio."),
    makeSkill("music", "# Music\nCompose and play music."),
    makeSkill("journal", "# Journal\nWrite diary entries."),
    makeSkill("cooking", "# Cooking\nRecipes and meal planning."),
    makeSkill("fitness", "# Fitness\nWorkout routines and tracking."),
    makeSkill("travel", "# Travel\nTravel planning and recommendations."),
  ];

  it("always includes always-on skills", () => {
    const { selected } = selectSkills(allSkills, "hello there");
    const names = selected.map((s) => s.name);
    for (const name of alwaysOnNames) {
      expect(names).toContain(name);
    }
  });

  it("scores relevant skills higher", () => {
    const { scores } = selectSkills(allSkills, "play some music for me");
    const musicScore = scores.find((s) => s.skill.name === "music")!;
    const cookingScore = scores.find((s) => s.skill.name === "cooking")!;
    expect(musicScore.score).toBeGreaterThan(cookingScore.score);
  });

  it("builds a directory of all skills", () => {
    const { directory } = selectSkills(allSkills, "anything");
    expect(directory.size).toBe(allSkills.length);
    for (const skill of allSkills) {
      expect(directory.has(skill.name)).toBe(true);
    }
  });

  it("handles empty message gracefully", () => {
    const { selected } = selectSkills(allSkills, "");
    // Should at least include always-on
    expect(selected.length).toBeGreaterThanOrEqual(alwaysOnNames.length);
  });
});

// ── extractRecentlyUsedSkills ───────────────────────────────────────

describe("extractRecentlyUsedSkills", () => {
  const allNames = ["weather", "stock-tracker", "music", "selfie"];

  it("detects direct tool name match", () => {
    const used = extractRecentlyUsedSkills([{ name: "weather" }], allNames);
    expect(used.has("weather")).toBe(true);
  });

  it("detects prefix match (underscore to hyphen)", () => {
    const used = extractRecentlyUsedSkills([{ name: "stock_lookup" }], allNames);
    expect(used.has("stock-tracker")).toBe(true);
  });

  it("returns empty set when no tools match", () => {
    const used = extractRecentlyUsedSkills([{ name: "unknown_tool" }], allNames);
    expect(used.size).toBe(0);
  });
});
