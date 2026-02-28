/**
 * Prompt auto-optimizer — watches recent conversations and patches
 * the system prompt when robot-like patterns are detected.
 *
 * Every 10 minutes it:
 *   1. Reads the last 40 messages from the session log
 *   2. Asks the model: "Are there robot-like patterns? Suggest one rule."
 *   3. If a useful rule is suggested, appends it to data/auto-rules.md
 *   4. context.ts reads auto-rules.md and injects it into the system prompt
 *
 * The optimizer is conservative: it only adds rules, never removes them,
 * and won't add a rule that's too similar to an existing one.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "../claude-runner.js";
import type { AppConfig } from "../types.js";
import { getCharacter, renderTemplate } from "../character.js";

const randMs = (minMin: number, maxMin: number) =>
  (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;
const MAX_MESSAGES_TO_ANALYZE = 40;
const AUTO_RULES_FILE = "auto-rules.md";
const STATE_FILE = "prompt-optimizer.json";
const MAX_AUTO_RULES = 20; // cap to avoid bloating the prompt
const SKIP_TOKEN = "SKIP";

interface OptimizerState {
  lastRunAt: number;
  lastMessageCount: number;
  rulesAdded: number;
}

export class PromptOptimizer {
  private config: AppConfig;
  private statePath: string;
  private stopped = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.statePath = config.statePath;
  }

  start(): void {
    console.log("[prompt-optimizer] Started");
    setTimeout(() => this.loop(), randMs(2, 5));
  }

  stop(): void { this.stopped = true; }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const added = await this.analyze();
      // Added a rule → check again sooner (new conversations may reveal more patterns)
      // No change → back off longer
      setTimeout(() => this.loop(), added ? randMs(8, 15) : randMs(15, 35));
    } catch (err) {
      console.error("[prompt-optimizer] Error:", err);
      setTimeout(() => this.loop(), randMs(5, 10));
    }
  }

  private loadState(): OptimizerState {
    const file = path.join(this.statePath, STATE_FILE);
    if (!fs.existsSync(file)) {
      return { lastRunAt: 0, lastMessageCount: 0, rulesAdded: 0 };
    }
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return { lastRunAt: 0, lastMessageCount: 0, rulesAdded: 0 };
    }
  }

  private saveState(state: OptimizerState): void {
    const file = path.join(this.statePath, STATE_FILE);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  }

  private loadAutoRules(): string[] {
    const file = path.join(this.statePath, AUTO_RULES_FILE);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
  }

  private appendRule(rule: string): void {
    const file = path.join(this.statePath, AUTO_RULES_FILE);
    const line = `- ${rule}\n`;
    fs.appendFileSync(file, line, "utf-8");
    console.log(`[prompt-optimizer] New rule added: ${rule}`);
  }

  private readRecentMessages(): { role: string; text: string }[] {
    const sessionFile = path.join(this.statePath, "sessions", "main.jsonl");
    if (!fs.existsSync(sessionFile)) return [];

    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    const messages: { role: string; text: string }[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!["user", "assistant"].includes(obj.role)) continue;

        let text = obj.content ?? "";
        if (Array.isArray(text)) {
          for (const block of text) {
            if (block?.type === "text") {
              text = block.text ?? "";
              break;
            }
          }
        }
        if (typeof text === "string" && text.trim()) {
          messages.push({ role: obj.role, text: text.trim() });
        }
      } catch {
        // skip malformed lines
      }
    }

    return messages.slice(-MAX_MESSAGES_TO_ANALYZE);
  }

  private async analyze(): Promise<boolean> {
    const state = this.loadState();
    const messages = this.readRecentMessages();

    // Skip if no new messages since last run
    if (messages.length <= state.lastMessageCount) {
      return false;
    }

    // Only look at assistant messages (those are what we want to improve)
    const assistantMessages = messages
      .filter((m) => m.role === "assistant")
      .slice(-15)
      .map((m) => m.text);

    if (assistantMessages.length < 3) return false;

    const existingRules = this.loadAutoRules();
    if (existingRules.length >= MAX_AUTO_RULES) {
      console.log("[prompt-optimizer] Max rules reached, skipping");
      return false;
    }

    const existingRulesText =
      existingRules.length > 0
        ? `\n\nExisting auto-rules (do not duplicate):\n${existingRules.map((r) => `- ${r}`).join("\n")}`
        : "";

    const recentResponses = assistantMessages.map((m, i) => `[${i + 1}] ${m}`).join("\n\n");

    const customPrompt = getCharacter().persona.prompt_optimizer;
    const prompt = customPrompt
      ? renderTemplate(customPrompt, undefined, { responses: recentResponses, existingRulesText, SKIP_TOKEN })
      : `You're helping an AI character named "${getCharacter().name}" improve their speaking style. They should sound like a real friend texting, not an AI assistant.

Here are their recent replies:
${recentResponses}
${existingRulesText}

Analyze these replies and find the most obvious "robotic/AI assistant" pattern.

If you find a problem, write a specific prohibition rule in one sentence:
Prohibit: [specific rule]

Rule requirements:
- Very specific, targeting actual observed issues
- No more than 30 words
- Don't duplicate existing rules

If the replies are already natural with no obvious issues, output only: ${SKIP_TOKEN}`;

    try {
      const output = (await claudeText({
        system: "You are a prompt optimization assistant. Output only the rule or SKIP.",
        prompt,
        model: "fast",
        timeoutMs: 30_000,
      })).trim() || SKIP_TOKEN;

      let added = false;
      if (output === SKIP_TOKEN || output.includes(SKIP_TOKEN)) {
        console.log("[prompt-optimizer] No issues found, skipping");
      } else if (output.startsWith("Prohibit:") || output.startsWith("禁止：")) {
        const rule = output.replace(/^(Prohibit:|禁止：)\s*/, "").trim();
        if (rule.length > 5 && rule.length <= 80) {
          this.appendRule(rule);
          state.rulesAdded++;
          added = true;
        }
      }

      state.lastRunAt = Date.now();
      state.lastMessageCount = messages.length;
      this.saveState(state);
      return added;
    } catch (err) {
      console.error("[prompt-optimizer] API error:", err);
      return false;
    }
  }
}
