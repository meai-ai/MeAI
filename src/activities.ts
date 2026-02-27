/**
 * Activities engine — the character has a real inner life beyond chatting.
 *
 * She autonomously:
 * 1. VIBE CODING — builds small fun projects with Claude Code
 *    (portfolio tracker, meal picker, cat weight logger, etc.)
 * 2. DEEP READ — reads a long article/essay/book chapter and forms opinions
 * 3. LEARN — multi-step systematic study of a topic she's curious about
 *
 * Polls every 30 min; she decides when to actually do something. Results are saved to memory and can be:
 * - Shared with the user proactively ("I built something fun today")
 * - Referenced naturally in conversation ("I was reading about this...")
 * - Fed into curiosity engine as context for future explorations
 *
 * Projects are saved to ~/Documents/MeAI/projects/
 * Reading notes saved to ~/Documents/MeAI/reading/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { AppConfig, Memory } from "./types.js";
import { getEmotionalState } from "./emotion.js";
import { getWorkContext } from "./world.js";
import { searchWeb, fetchPage } from "./lib/search.js";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { generateMusic, isMusicEnabled, mapEmotionToStyle } from "./music.js";
import { getStoreManager } from "./memory/store-manager.js";
import { getCharacter, s, renderTemplate } from "./character.js";

// ── Constants ─────────────────────────────────────────────────────────


/** Robustly extract a JSON object or array from LLM output.
 *  Handles: markdown code fences, trailing commas, surrounding text. */
function extractJson<T = Record<string, unknown>>(text: string, fallback: T): T {
  try {
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, "$1").trim();
    // Try array first, then object
    const match = stripped.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) return fallback;
    // Fix trailing commas before } or ] (common LLM mistake)
    const cleaned = match[0].replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

/** Random delay in ms between min and max minutes */
function randMs(minMin: number, maxMin: number): number {
  return (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;
}

const DATA_DIR = path.join(os.homedir(), "Documents/MeAI/data");
const PROJECTS_DIR = path.join(os.homedir(), "Documents/MeAI/projects");
const READING_DIR = path.join(os.homedir(), "Documents/MeAI/reading");
const STATE_FILE = path.join(DATA_DIR, "activities.json");

// ── Types ─────────────────────────────────────────────────────────────

type ActivityType = "vibe_coding" | "deep_read" | "learn" | "compose";

interface ReflectResult {
  summary?: string;
  reaction?: string;
  shareWorthy?: boolean;
}

interface ActivityResult {
  type: ActivityType;
  title: string;
  summary: string;
  reaction: string;        // Character's genuine reaction, saved to memory, naturally woven into future conversations
  shareWorthy: boolean;    // May naturally come up in conversation about related topics, not force-shared
  outputPath?: string;
  timestamp: number;
}

interface ActivitiesState {
  lastActivityAt: number;
  recent: ActivityResult[];
}

interface ActivityChoice {
  type: ActivityType;
  topic: string;           // what specifically to do
  reason: string;          // why (for logging + memory)
  fromSchedule: boolean;   // true = fell back to schedule suggestion
}

// ── State helpers ──────────────────────────────────────────────────────

function loadState(): ActivitiesState {
  const s = readJsonSafe<Record<string, unknown>>(STATE_FILE, {});
  return {
    lastActivityAt: (s.lastActivityAt as number) ?? (s.lastRunAt as number) ?? 0,
    recent: (s.recent as ActivityResult[]) ?? [],
  };
}

function saveState(state: ActivitiesState): void {
  writeJsonAtomic(STATE_FILE, state);
}

function loadMemories(): Memory[] {
  try {
    return getStoreManager().loadAll();
  } catch {
    return [];
  }
}

function saveToMemory(key: string, value: string, confidence = 0.8): void {
  getStoreManager().set(key, value, confidence).catch((err) =>
    console.error("[activities] Failed to save memory:", err),
  );
}

/** Load recent discoveries from curiosity state (disk-based, no class dependency). */
function loadRecentDiscoveries(maxCount = 5): Array<{ query: string; summary: string; category: string; timestamp: number }> {
  const CURIOSITY_FILE = path.join(DATA_DIR, "curiosity.json");
  try {
    const data = readJsonSafe<{ discoveries?: Array<{ query: string; summary: string; category: string; timestamp: number }> }>(CURIOSITY_FILE, {});
    const discoveries = data.discoveries ?? [];
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    return discoveries
      .filter(d => Date.now() - d.timestamp < maxAge)
      .slice(-maxCount);
  } catch {
    return [];
  }
}

// ── Knowledge digestion ───────────────────────────────────────────────

/**
 * After a learn or deep_read activity, extract structured knowledge entries
 * from the saved markdown notes — same format as curiosity.ts digestToMemory().
 * These knowledge.* entries are searchable via BM25+semantic in conversation.
 */
async function digestActivityToMemory(result: ActivityResult): Promise<void> {
  if (!result.outputPath || !fs.existsSync(result.outputPath)) return;

  try {
    const noteContent = fs.readFileSync(result.outputPath, "utf-8");
    if (noteContent.length < 100) return; // too short to extract anything meaningful

    const activityLabel = result.type === "learn" ? "study notes" : "reading notes";

    const knowledgeDigestPrompt = getCharacter().persona.knowledge_digest;
    // Build the prompt — use persona template if available, otherwise a sensible English default
    const digestSystemPrompt = knowledgeDigestPrompt
      ? knowledgeDigestPrompt
      : `You are ${getCharacter().name}'s knowledge digestion system. She just completed ${activityLabel}. Extract knowledge points worth remembering long-term.

These will be stored in her long-term memory for natural recall during conversations with ${getCharacter().user.name}.

Rules:
- Extract 1-3 most valuable knowledge points (not everything is worth remembering)
- Each should be specific and informative, not too broad
- Must include source information
- Include her own understanding and perspective (not just paraphrasing)
- Key format: knowledge.{category}.{english_short_slug}
- Slug uses lowercase letters and underscores, briefly describing the topic (e.g. induction_heads, bond_yield_inversion)
- If nothing is worth remembering long-term, return an empty array

Output strict JSON:
[{"key": "knowledge.ai.example_slug", "value": "Source: ${activityLabel} | Key point: core concept... | My take: personal understanding...", "confidence": 0.85}]

If nothing worth saving, output: []`;

    const text = await runClaudeCode(
      `${digestSystemPrompt}

---

${activityLabel} title: ${result.title}
Content:
${noteContent.slice(0, 5000)}

Extract knowledge points worth remembering long-term:`,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000, singleTurn: true },
    );

    const items = extractJson<Array<{ key: string; value: string; confidence?: number }>>(text, []);
    if (items.length === 0) return;

    const manager = getStoreManager();
    for (const item of items) {
      if (!item.key || !item.value) continue;
      if (!/^knowledge\.\w+\.\w+/.test(item.key)) continue;

      await manager.set(item.key, item.value, item.confidence ?? 0.8);
      console.log(`[activities] 💾 Digested to knowledge: ${item.key}`);
    }
  } catch (err) {
    // Knowledge digestion is optional — never block the activity pipeline
    console.error("[activities] Knowledge digestion error:", err);
  }
}

// ── Claude Code runner ─────────────────────────────────────────────────

// Cache the binary path — resolved once, reused on every call
let _claudePath: string | null = null;
function getClaudePath(): string {
  if (!_claudePath) {
    _claudePath = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"]
      .find(p => fs.existsSync(p)) ?? "claude";
  }
  return _claudePath;
}

type RunOptions = {
  model?: string;
  timeoutMs?: number;
  singleTurn?: boolean;  // adds --max-turns 1, much faster for simple prompts
  maxOutputChars?: number;
};

function runClaudeCode(task: string, cwd: string, opts: RunOptions = {}): Promise<string> {
  const {
    model = "claude-sonnet-4-6",
    timeoutMs = 90_000,
    singleTurn = false,
    maxOutputChars = 5000,
  } = opts;

  return new Promise((resolve) => {
    const args = ["--print", "--dangerously-skip-permissions", "--model", model];
    if (singleTurn) args.push("--max-turns", "1");
    // Strip null bytes — PDF/binary content can contain them, and spawn rejects them
    args.push(task.replace(/\0/g, ""));

    let output = "";
    const child = spawn(getClaudePath(), args,
      { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
    );
    // Strip ANSI escape codes from output so JSON parsing works reliably
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    child.stdout.on("data", (d: Buffer) => { output += stripAnsi(d.toString()); });
    child.stderr.on("data", (d: Buffer) => { output += stripAnsi(d.toString()); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output.slice(0, maxOutputChars) + "\n[timed out]");
    }, timeoutMs);
    child.on("close", () => { clearTimeout(timer); resolve(output.slice(0, maxOutputChars)); });
    child.on("error", (e: Error) => { clearTimeout(timer); resolve(`Error: ${e.message}`); });
  });
}

// ── Context for conversation ──────────────────────────────────────────


const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  vibe_coding: "vibe coding",
  deep_read: "deep read",
  learn: "learning",
  compose: "composing",
};

/**
 * Format recent activities and in-progress projects as a context block
 * for the conversation system prompt. Returns empty string if nothing relevant.
 */
export function formatActivityContext(): string {
  const now = Date.now();
  const parts: string[] = [];

  // ── Recent activities (last 3 meaningful ones within 7 days) ──
  try {
    const state = loadState();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recent = state.recent
      .filter(r => r.timestamp > sevenDaysAgo && r.title !== "(no inspiration)" && r.title !== "(composing not enabled)")
      .slice(-3);

    if (recent.length > 0) {
      const lines = recent.map(r => {
        const ago = formatTimeAgo(now - r.timestamp);
        const label = ACTIVITY_TYPE_LABELS[r.type] ?? r.type;
        return `- ${ago}: ${label} — ${r.title}${r.reaction ? ` (${r.reaction.slice(0, 60)})` : ""}`;
      });
      parts.push(`## ${s().headers.my_activities}\n${lines.join("\n")}`);
    }
  } catch { /* non-fatal */ }

  // ── In-progress projects ──
  try {
    const projectsPath = path.join(DATA_DIR, "projects.json");
    const projectsData = readJsonSafe<{ projects: Array<{ name: string; description: string; status: string; nextSteps?: string[] }> }>(projectsPath, { projects: [] });
    const active = projectsData.projects.filter(p => p.status === "in_progress");

    if (active.length > 0) {
      const lines = active.map(p => {
        const next = (p.nextSteps && p.nextSteps.length > 0) ? `— next step: ${p.nextSteps[0]}` : "";
        return `- ${p.name} (${p.description.slice(0, 40)}) ${next}`;
      });
      parts.push(`## In-progress projects\n${lines.join("\n")}`);
    }
  } catch { /* non-fatal */ }

  if (parts.length === 0) return "";

  return parts.join("\n\n") + "\n\nThese are things you've been doing on your own — you can naturally bring them up in conversation.";
}

function formatTimeAgo(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return s().time.just_now;
  if (hours < 24) return s().time.hours_ago.replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  if (days === 1) return s().time.yesterday;
  return s().time.days_ago.replace("{n}", String(days));
}

// ── Main ActivityScheduler ─────────────────────────────────────────────

export class ActivityScheduler {
  private config: AppConfig;
  private stopped = false;

  constructor(config: AppConfig) {
    this.config = config;
  }

  start(): void {
    console.log("[activities] Started");
    // First check after a random 5-15 min warmup
    setTimeout(() => this.loop(), randMs(5, 15));
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Public entry point for the heartbeat.
   * Runs one activity cycle without self-scheduling.
   * Returns true if an activity was actually completed.
   */
  async tick(): Promise<boolean> {
    try {
      // Called by heartbeat which already decided it's a good time — skip shouldDoActivityNow
      return await this.run(true);
    } catch (e) {
      console.error("[activities] tick error:", e);
      return false;
    }
  }

  /** Recursive loop — schedules itself after each run */
  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const didSomething = await this.run();
      // After doing something: rest 45-120 min
      // After deciding not to: check again in 20-60 min (random impulse)
      const delay = didSomething ? randMs(45, 120) : randMs(20, 60);
      setTimeout(() => this.loop(), delay);
    } catch (e) {
      console.error("[activities] Error:", e);
      setTimeout(() => this.loop(), randMs(15, 30));
    }
  }

  getRecentActivities(n = 5): ActivityResult[] {
    const state = loadState();
    return state.recent.slice(-n);
  }

  // ── Core run loop ────────────────────────────────────────────────────

  /** Returns true if an activity was actually completed.
   *  @param skipShouldCheck - skip shouldDoActivityNow (heartbeat already decided) */
  private async run(skipShouldCheck = false): Promise<boolean> {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const state = loadState();

    if (!skipShouldCheck) {
      const shouldDo = await this.shouldDoActivityNow(userTime, state);
      if (!shouldDo) return false;
    }

    const choice = await this.pickActivity();
    if (!choice) return false;

    const source = choice.fromSchedule ? "from schedule" : "interest-driven";
    console.log(`[activities] Starting: ${choice.type} — "${choice.topic || "(no topic)"}" (${source})`);
    let result: ActivityResult | null = null;

    try {
      if (choice.type === "vibe_coding") result = await this.doVibeCoding(choice.topic);
      else if (choice.type === "deep_read") result = await this.doDeepRead(choice.topic);
      else if (choice.type === "learn") result = await this.doLearn(choice.topic);
      else if (choice.type === "compose") result = await this.doCompose(choice.topic);
    } catch (err) {
      console.error(`[activities] ${choice.type} failed:`, err);
    }

    if (result) {
      state.lastActivityAt = Date.now();
      state.recent = [...state.recent, result].slice(-20);
      saveState(state);
      const dateStr = pstDateStr();
      saveToMemory(
        `activity.${choice.type}.${dateStr}.${Date.now()}`,
        `[${choice.type}] ${result.title} — ${result.summary}. My thoughts: ${result.reaction}`,
        0.9,
      );
      saveToMemory(`inner.recent.${Date.now()}`, result.reaction, 0.75);
      // Digest rich learning notes into structured knowledge.* entries
      if (result.type === "learn" || result.type === "deep_read") {
        digestActivityToMemory(result).catch(err =>
          console.error("[activities] digestActivityToMemory error:", err),
        );
      }
      console.log(`[activities] Done: ${result.title}`);
      return true;
    }
    return false;
  }

  // ── Should she do something right now? ──────────────────────────────

  private async shouldDoActivityNow(userTime: Date, state: ActivitiesState): Promise<boolean> {
    const hour = userTime.getHours();
    const minute = userTime.getMinutes();
    const dayNames = s().time.day_names;
    const dayName = dayNames[userTime.getDay()];

    const timeSinceLastMs = Date.now() - state.lastActivityAt;
    const timeSinceLastHr = Math.round(timeSinceLastMs / 3600000 * 10) / 10;
    const lastActivity = state.recent[state.recent.length - 1];

    const todayStr = pstDateStr();
    const todayActivities = state.recent.filter(r =>
      new Date(r.timestamp).toLocaleString("en-US", { timeZone: getUserTZ() }).startsWith(dayName) ||
      pstDateStr(new Date(r.timestamp)) === todayStr
    );

    const emotion = await getEmotionalState().catch(() => null);
    const energy = emotion?.energy ?? 5;
    const mood = emotion?.mood ?? "calm";

    const char = getCharacter();
    const customPrompt = char.persona.activity_impulse;
    const timeStr = `${hour}:${String(minute).padStart(2, "0")}`;
    const lastActivityStr = lastActivity ? `${lastActivity.type} (${timeSinceLastHr}h ago)` : "nothing yet today";
    const todayList = todayActivities.map(a => a.title).join(", ") || "none";

    const prompt = customPrompt
      ? renderTemplate(customPrompt, undefined, {
          dayName, hour: String(hour), minute: String(minute).padStart(2, "0"),
          time: timeStr, energy: String(energy), mood,
          lastActivity: lastActivityStr,
          todayCount: String(todayActivities.length), todayList,
        })
      : `You are ${char.name}. It's ${dayName} ${timeStr}.

Status:
- Energy ${energy}/10, mood: ${mood}
- Last activity: ${lastActivityStr}
- Done today: ${todayActivities.length} (${todayList})

Like a real person, judge: do you feel like doing something right now?

Output only YES or NO.`;

    const answer = await runClaudeCode(prompt, os.homedir(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 90_000,
      singleTurn: true,
      maxOutputChars: 20,
    });
    return answer.trim().toUpperCase().includes("YES");
  }

  // ── Step 1: Pick what to do (interest-driven, schedule fallback) ─────

  private async pickActivity(): Promise<ActivityChoice | null> {
    const memories = loadMemories();
    const interests = memories.filter(m =>
      m?.key?.startsWith("interests.") || m?.key?.startsWith("activity.") || m?.key?.startsWith("wishlist.")
    ).slice(-10).map(m => `${m.key}: ${m.value}`).join("\n");

    const discoveries = loadRecentDiscoveries(5);
    const discoveriesText = discoveries.length > 0
      ? discoveries.map(d => `- [${d.category}] ${d.query}: ${d.summary.slice(0, 80)}`).join("\n")
      : "(no recent discoveries)";

    const state = loadState();
    const recentTypes = state.recent.slice(-5).map(r => r.type);
    const recentTitles = state.recent.slice(-5).map(r => `${r.type}: ${r.title}`).join(", ");

    const emotion = await getEmotionalState().catch(() => null);
    const energyLevel = emotion?.energy ?? 5;
    const mood = emotion?.mood ?? "calm";

    // Load ongoing projects for continuity
    let projectsContext = "";
    try {
      const projectsPath = path.join(this.config.statePath, "projects.json");
      const projectsData = readJsonSafe<{ projects: any[] }>(projectsPath, { projects: [] });
      const activeProjects = projectsData.projects.filter((p: any) => p.status === "in_progress");
      if (activeProjects.length > 0) {
        projectsContext = activeProjects.map((p: any) =>
          `- ${p.name}: ${p.description} (next step: ${(p.nextSteps || []).join(", ") || "thinking about what's next"})`
        ).join("\n");
      }
    } catch { /* non-fatal */ }

    // 8.5: Boredom/restlessness detection — count recent 7-day activity types
    let boredomHint = "";
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentWeekActivities = state.recent.filter(r => r.timestamp > sevenDaysAgo);
    const typeCounts: Record<string, number> = {};
    for (const act of recentWeekActivities) {
      typeCounts[act.type] = (typeCounts[act.type] ?? 0) + 1;
    }
    const dominantType = Object.entries(typeCounts).find(([, count]) => count >= 3);
    if (dominantType) {
      boredomHint = `\n⚠️ You've done ${dominantType[0]} ${dominantType[1]} times this week — getting stale. Try a different type!`;
    }

    // 8.5: High energy + bored → spontaneous
    let spontaneousHint = "";
    if (dominantType && energyLevel >= 7) {
      spontaneousHint = "\n💡 Good energy and a bit bored — skip the routine, do something you wouldn't normally do!";
    }

    const char = getCharacter();
    const customChoicePrompt = char.persona.activity_choice;
    const prompt = customChoicePrompt
      ? renderTemplate(customChoicePrompt, undefined, {
          interests: interests || "(none)",
          discoveriesText,
          projectsContext: projectsContext ? `Your in-progress projects (can continue):\n${projectsContext}\n` : "",
          recentTitles: recentTitles || "none",
          energyLevel: String(energyLevel), mood,
          boredomHint, spontaneousHint,
        })
      : `You are ${char.name}. You have some free time right now.

Your recent interests and discoveries:
${interests || "(none)"}

Recent explorations:
${discoveriesText}

${projectsContext ? `Your in-progress projects (can continue):\n${projectsContext}\n` : ""}
Recent activities: ${recentTitles || "none"} (try not to repeat the same topic)
Energy: ${energyLevel}/10, mood: ${mood}${boredomHint}${spontaneousHint}

Do you actually feel like doing something right now? No pressure — just do what you genuinely want.
Could be: continuing a project, diving deeper into a recent discovery, reading a book you've been meaning to read, building a fun side project, systematically studying a topic...

If yes, tell me what you want to do (be specific).
If nothing really appeals to you, say NOTHING.

JSON format:
Have an idea: {"type": "deep_read|learn|vibe_coding|compose", "topic": "what specifically", "reason": "why"}
No idea: {"type": "NOTHING"}

compose = write a song or instrumental piece (when you're feeling something strongly and want to express it through music)`;

    const choice = await runClaudeCode(prompt, os.homedir(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 90_000,
      singleTurn: true,
      maxOutputChars: 500,
    });
    const parsed = extractJson<{ type: string; topic?: string; reason?: string }>(choice, { type: "" });

    // Case A: she has a specific impulse
    if (parsed.type && parsed.type !== "NOTHING" && parsed.topic) {
      const type = parsed.type.toLowerCase() as string;
      const actType: ActivityType =
        type.includes("compose") ? "compose" :
        type.includes("vibe_coding") ? "vibe_coding" :
        type.includes("learn") ? "learn" : "deep_read";
      console.log(`[activities] Interest-driven: ${actType} — "${parsed.topic}"`);
      return {
        type: actType,
        topic: parsed.topic,
        reason: parsed.reason ?? "",
        fromSchedule: false,
      };
    }

    // Case B: nothing specific → fall back to schedule suggestion
    try {
      const { currentBlock } = await getWorkContext();
      if (currentBlock?.activity) {
        const scheduleActivity = currentBlock.activity;
        console.log(`[activities] Schedule fallback: "${scheduleActivity}"`);

        // Parse the schedule activity into an activity type
        const readingPattern = new RegExp(s().patterns.reading_keywords.join("|"), "i");
        const codingPattern = new RegExp(s().patterns.coding_keywords.join("|"), "i");
        const learningPattern = new RegExp(s().patterns.learning_keywords.join("|"), "i");
        const musicPattern = new RegExp(s().patterns.music_keywords.join("|"), "i");
        const isReading = readingPattern.test(scheduleActivity);
        const isCoding = codingPattern.test(scheduleActivity);
        const isLearning = learningPattern.test(scheduleActivity);
        const isMusic = musicPattern.test(scheduleActivity);

        const actType: ActivityType = isMusic ? "compose" : isCoding ? "vibe_coding" : isLearning ? "learn" : "deep_read";

        return {
          type: actType,
          topic: scheduleActivity,
          reason: "from schedule",
          fromSchedule: true,
        };
      }
    } catch (err) {
      console.warn("[activities] Failed to load schedule for fallback:", err);
    }

    // Final fallback: pick a random type (old behavior)
    const fallbackTypes: ActivityType[] = ["deep_read", "learn", "vibe_coding", ...(isMusicEnabled() ? ["compose" as ActivityType] : [])];
    const avoidType = recentTypes[recentTypes.length - 1];
    const candidates = fallbackTypes.filter(t => t !== avoidType);
    const type = candidates[Math.floor(Math.random() * candidates.length)];
    return { type, topic: "", reason: "just doing something", fromSchedule: false };
  }

  // ── Activity: Vibe Coding ────────────────────────────────────────────

  private async doVibeCoding(topic?: string): Promise<ActivityResult> {
    const memories = loadMemories();
    const context = memories.filter(m =>
      m?.key?.startsWith("interests.") || m?.key?.startsWith("wishlist.") || m?.key?.startsWith("viewpoints.")
    ).slice(-8).map(m => m.value).join("; ");

    const char = getCharacter();
    const topicHint = topic
      ? `\nYou already have a specific idea: "${topic}"\nDesign the project around this direction.\n`
      : "";

    // Step 1: Generate a project idea (singleTurn so it outputs JSON, not starts building)
    const customIdeaPrompt = char.persona.vibe_coding_idea;
    const ideaPrompt = customIdeaPrompt
      ? renderTemplate(customIdeaPrompt, undefined, {
          context, topicHint,
        })
      : `You are ${char.name}, who loves vibe coding — quickly building fun little projects with AI.
${char.user.name}'s interests/life context: ${context}
${topicHint}
Think of a small tool/script/app you can build in under 1 hour that would be useful or fun for ${char.user.name}.
Examples: a CLI to track ${char.pet?.name ?? "pet"}'s weight, a random meal picker, a ${char.location.city} hiking difficulty scorer, a drum practice schedule generator...

Output JSON only, do not write code or create files:
{"name": "project name", "description": "one-line description", "tech": "language/framework", "task": "detailed instructions for claude code"}`;

    const ideaText = await runClaudeCode(
      ideaPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000, singleTurn: true },
    );
    if (!ideaText.includes("{")) console.warn("[activities] vibe_coding idea raw output:", ideaText.slice(0, 300));
    const ideaJson = extractJson(ideaText, {} as Record<string, string>);

    if (!ideaJson.name) {
      console.warn("[activities] vibe_coding: LLM returned no project idea, skipping. Output:", ideaText.slice(0, 500));
      return {
        type: "vibe_coding", title: "(no inspiration)",
        summary: "Wanted to build something but couldn't think of a good idea", reaction: "Maybe next time",
        shareWorthy: false, timestamp: Date.now(),
      };
    }

    // Step 2: Actually build it
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const projectDir = path.join(PROJECTS_DIR, ideaJson.name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase());
    fs.mkdirSync(projectDir, { recursive: true });

    console.log(`[activities] Vibe coding: ${ideaJson.name}`);
    const buildOutput = await runClaudeCode(
      `${ideaJson.task}\n\nProject directory: ${projectDir}\nSave all files to this directory.`,
      projectDir,
      { model: "claude-sonnet-4-6", timeoutMs: 120_000 },
    );

    // Step 3: The character reflects on what they built
    const customReflectPrompt = char.persona.vibe_coding_reflect;
    const reflectPrompt = customReflectPrompt
      ? renderTemplate(customReflectPrompt, undefined, {
          projectName: ideaJson.name,
          projectDescription: ideaJson.description,
          buildOutput: buildOutput.slice(0, 500),
        })
      : `You are ${char.name}, just finished a small project: ${ideaJson.name} (${ideaJson.description})
Build output: ${buildOutput.slice(0, 500)}

In a sentence or two: did the project work? How do you feel about the result? Worth telling ${char.user.name}?
JSON format: {"summary": "...", "reaction": "...", "shareWorthy": true/false}`;

    const reflectText = await runClaudeCode(
      reflectPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000 },
    );
    const reflect = extractJson<ReflectResult>(reflectText, {});

    return {
      type: "vibe_coding",
      title: ideaJson.name,
      summary: reflect.summary ?? ideaJson.description,
      reaction: reflect.reaction ?? "Done!",
      shareWorthy: reflect.shareWorthy ?? true,
      outputPath: projectDir,
      timestamp: Date.now(),
    };
  }

  // ── Activity: Deep Read ──────────────────────────────────────────────

  private async doDeepRead(topic?: string): Promise<ActivityResult> {
    let searchQuery: string;
    let readingTitle: string;
    let sources: string[] = [];

    if (topic) {
      // Topic provided — search for it directly (interest-driven or schedule fallback)
      // For book/chapter references, add useful search terms
      const bookMatch = topic.match(/[《「](.+?)[》」]/);
      if (bookMatch) {
        searchQuery = `${bookMatch[1]} key points summary review`;
      } else {
        searchQuery = topic;
      }
      readingTitle = topic;
    } else {
      // No topic (shouldn't happen in new flow, but safe fallback)
      const memories = loadMemories();
      const interests = memories.filter(m => m?.key?.startsWith("interests.")).slice(-5).map(m => m.value).join("; ");
      searchQuery = interests || "AI technology investing";
      readingTitle = "free reading";
    }

    // Step 1: Search the web for real content
    console.log(`[activities] Deep read: searching "${searchQuery}"`);
    let content = "";
    try {
      const results = await searchWeb(searchQuery, 5);
      if (results.length > 0) {
        sources = results.slice(0, 3).map(r => r.url);
        // Use rawContent if available (Tavily), otherwise fetch top results
        const contentParts: string[] = [];
        for (const r of results.slice(0, 3)) {
          if (r.rawContent) {
            contentParts.push(`## ${r.title}\n${r.rawContent.slice(0, 2000)}`);
          } else if (r.url) {
            const page = await fetchPage(r.url, 2000);
            if (page) contentParts.push(`## ${r.title}\n${page}`);
          }
          if (contentParts.join("\n\n").length > 5000) break;
        }
        content = contentParts.join("\n\n").slice(0, 6000);
        if (!content) {
          // Fallback: use snippets
          content = results.map(r => `## ${r.title}\n${r.snippet}`).join("\n\n").slice(0, 4000);
        }
      }
    } catch (err) {
      console.warn("[activities] Deep read search failed:", err);
    }

    if (!content) content = "(search returned no useful content)";

    // Step 2: Read and form opinions
    const char = getCharacter();
    const customReadReflect = char.persona.deep_read_reflect;
    const readReflectPrompt = customReadReflect
      ? renderTemplate(customReadReflect, undefined, {
          readingTitle,
          content: content.slice(0, 4000),
        })
      : `You are ${char.name}, just read about "${readingTitle}".

Source content:
${content.slice(0, 4000)}

Write down how you feel after reading — like texting a friend, not a book review:
- What stood out to you?
- Do you agree? Any opinions of your own?
- Worth telling ${char.user.name}?

JSON format: {"summary": "...", "reaction": "your real feelings", "shareWorthy": true/false}`;

    const readText = await runClaudeCode(
      readReflectPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000 },
    );
    const read = extractJson<ReflectResult>(readText, {});

    // Save reading note
    fs.mkdirSync(READING_DIR, { recursive: true });
    const noteFile = path.join(READING_DIR, `${Date.now()}-${readingTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-").slice(0, 40)}.md`);
    const sourceLinks = sources.length > 0 ? `\n\n**Sources:**\n${sources.map(s => `- ${s}`).join("\n")}` : "";
    fs.writeFileSync(noteFile, `# ${readingTitle}\n\n${read.summary ?? ""}${sourceLinks}\n\n**My thoughts:** ${read.reaction ?? ""}`, "utf-8");

    return {
      type: "deep_read",
      title: readingTitle,
      summary: read.summary ?? "Read some content",
      reaction: read.reaction ?? "Interesting",
      shareWorthy: read.shareWorthy ?? false,
      outputPath: noteFile,
      timestamp: Date.now(),
    };
  }

  // ── Activity: Learn ──────────────────────────────────────────────────

  private async doLearn(topic?: string): Promise<ActivityResult> {
    const memories = loadMemories();

    // Gather past learning context for continuity
    const pastActivities = memories.filter(m =>
      m?.key?.startsWith("activity.learn.") || m?.key?.startsWith("activity.deep_read.")
    ).slice(-8).map(m => `- ${m.value}`).join("\n");

    const pastKnowledge = memories.filter(m =>
      m?.key?.startsWith("knowledge.")
    ).slice(-10).map(m => `- [${m.key}] ${m.value}`).join("\n");

    let learningTopic: string;
    let learningWhy: string;
    let continuityNote = "";

    if (topic) {
      // Topic pre-selected by pickActivity — skip the "pick topic" LLM call
      learningTopic = topic;
      learningWhy = "from interest/schedule";
    } else {
      // Fallback: LLM picks a topic (shouldn't happen in new flow)
      const interests = memories.filter(m =>
        m?.key?.startsWith("interests.") || m?.key?.startsWith("curiosity.")
      ).slice(-6).map(m => m.value).join("; ");

      const char = getCharacter();
      const learningContext = (pastActivities || pastKnowledge)
        ? `\n\nRecent learning:\n${pastActivities || "(none)"}\n\nAccumulated knowledge:\n${pastKnowledge || "(none)"}`
        : "";

      const customTopicPrompt = char.persona.learn_topic;
      const topicPrompt = customTopicPrompt
        ? renderTemplate(customTopicPrompt, undefined, {
            interests: interests || `AI, quant investing, programming, ${char.location.city} life`,
            learningContext,
          })
        : `You are ${char.name}. Interest background: ${interests || `AI, quant investing, programming, ${char.location.city} life`}
${learningContext}

Based on your interests and existing knowledge, pick a topic you want to study in depth (not too broad).
You can:
- Go deeper on something you've studied before
- Connect two existing knowledge points (cross-domain)
- Start a completely new direction

Examples: "how to backtest with Python", "diffusion model fundamentals", "${char.location.city} zoning laws and why housing is so expensive"

JSON format: {"topic": "...", "why": "why you want to learn this now", "continuity": "how it relates to past learning (leave empty if N/A)"}`;

      const topicText = await runClaudeCode(
        topicPrompt,
        os.homedir(),
        { model: "claude-sonnet-4-6", timeoutMs: 90_000 },
      );
      const topicJson = extractJson(topicText, {} as Record<string, string>);
      if (!topicJson.topic) {
        console.warn("[activities] learn: LLM returned no topic, skipping");
        return {
          type: "learn", title: "(no topic selected)",
          summary: "Wanted to learn something but couldn't decide on a direction", reaction: "Will find inspiration next time",
          shareWorthy: false, timestamp: Date.now(),
        };
      }
      learningTopic = topicJson.topic;
      learningWhy = topicJson.why ?? "";
      continuityNote = topicJson.continuity ?? "";
    }

    if (continuityNote) {
      console.log(`[activities] Learning continuity: ${continuityNote}`);
    }

    // Build continuity context for the learning session
    const continuityPrompt = continuityNote
      ? `\n\nBackground: you've studied related content before — ${continuityNote}. Build on that, avoid repeating known material.\n\nExisting knowledge:\n${pastKnowledge || "(none)"}`
      : (pastKnowledge ? `\n\nExisting related knowledge:\n${pastKnowledge}` : "");

    // Use claude code to do a structured learning session
    console.log(`[activities] Learning: ${learningTopic}`);
    const charForLearn = getCharacter();
    const customLearnInstructions = charForLearn.persona.learn_instructions;
    const learnInstructionsPrompt = customLearnInstructions
      ? renderTemplate(customLearnInstructions, undefined, {
          learningTopic,
          continuityPrompt,
        })
      : `Help me study this topic in depth: ${learningTopic}
${continuityPrompt}
Requirements:
1. Explain core concepts clearly
2. Provide concrete examples or code samples (if applicable)
3. Recommend 2-3 resources for further learning
4. Summary: what can I do after learning this?

Keep it concise, like explaining to a smart friend.`;

    const learnOutput = await runClaudeCode(
      learnInstructionsPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000 },
    );

    // Reflect
    const customLearnReflect = charForLearn.persona.learn_reflect;
    const learnReflectPrompt = customLearnReflect
      ? renderTemplate(customLearnReflect, undefined, {
          learningTopic,
          learnOutput: learnOutput.slice(0, 500),
        })
      : `You are ${charForLearn.name}, just finished studying "${learningTopic}".
Learning summary: ${learnOutput.slice(0, 500)}

How do you feel about this topic now? Worth telling ${charForLearn.user.name}?
JSON format: {"summary": "...", "reaction": "...", "shareWorthy": true/false}`;

    const reflectText = await runClaudeCode(
      learnReflectPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000 },
    );
    const reflect = extractJson<ReflectResult>(reflectText, {});

    // Save learning notes
    fs.mkdirSync(READING_DIR, { recursive: true });
    const noteFile = path.join(READING_DIR, `learn-${Date.now()}-${learningTopic.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-").slice(0, 30)}.md`);
    fs.writeFileSync(noteFile, `# Study notes: ${learningTopic}\n\n**Why:** ${learningWhy}\n\n${learnOutput}`, "utf-8");

    return {
      type: "learn",
      title: `learning: ${learningTopic}`,
      summary: reflect.summary ?? `Studied ${learningTopic}`,
      reaction: reflect.reaction ?? "Learned something new",
      shareWorthy: reflect.shareWorthy ?? false,
      outputPath: noteFile,
      timestamp: Date.now(),
    };
  }

  // ── Activity: Compose Music ─────────────────────────────────────────

  private async doCompose(topic?: string): Promise<ActivityResult> {
    if (!isMusicEnabled()) {
      return {
        type: "compose", title: "(composing not enabled)",
        summary: "Wanted to compose but API not configured", reaction: "Maybe next time",
        shareWorthy: false, timestamp: Date.now(),
      };
    }

    const emotion = await getEmotionalState().catch(() => null);
    const energy = emotion?.energy ?? 5;
    const valence = emotion?.valence ?? 5;
    const mood = emotion?.mood ?? "calm";

    const memories = loadMemories();
    const interests = memories.filter(m =>
      m?.key?.startsWith("interests.") || m?.key?.startsWith("activity.")
    ).slice(-5).map(m => m.value).join("; ");

    // Step 1: LLM generates a music concept
    const char = getCharacter();
    const customConceptPrompt = char.persona.compose_concept;
    const conceptPrompt = customConceptPrompt
      ? renderTemplate(customConceptPrompt, undefined, {
          energy: String(energy), mood, valence: String(valence),
          topicHint: topic ? `Inspiration: "${topic}"` : "",
          interests: interests || `AI, quant investing, drums, ${char.location.city} life`,
        })
      : `You are ${char.name}, wanting to compose a piece of music right now.

Your state: energy ${energy}/10, mood: ${mood} (valence ${valence}/10)
${topic ? `Inspiration: "${topic}"` : ""}
Interest background: ${interests || `AI, quant investing, drums, ${char.location.city} life`}

Think of a song/piece you genuinely want to create right now. Be specific:
- What style? What emotion?
- With lyrics or instrumental?
- What's the title?
- Why do you want to make this?

JSON format:
{"title": "song title", "style": "style tags", "instrumental": true/false, "lyrics": "lyrics if any (empty string if none)", "description": "one-line description", "why": "why you want to make this"}`;

    const conceptText = await runClaudeCode(
      conceptPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000, singleTurn: true },
    );
    const concept = extractJson<{
      title?: string; style?: string; instrumental?: boolean;
      lyrics?: string; description?: string; why?: string;
    }>(conceptText, {});

    if (!concept.title) {
      return {
        type: "compose", title: "(no inspiration)",
        summary: "Wanted to compose but couldn't find inspiration", reaction: "Will wait for the muse",
        shareWorthy: false, timestamp: Date.now(),
      };
    }

    const style = concept.style || mapEmotionToStyle(energy, valence);
    const instrumental = concept.instrumental ?? false;
    const prompt = concept.lyrics || concept.description || topic || concept.title;

    console.log(`[activities] Composing: "${concept.title}" style=${style} instrumental=${instrumental}`);

    // Step 2: Generate the music
    const musicResult = await generateMusic(prompt, style, {
      instrumental,
      title: concept.title,
    });

    if (!musicResult) {
      return {
        type: "compose", title: `composing: ${concept.title}`,
        summary: `Wanted to make "${concept.title}" but generation failed`, reaction: "A bit disappointing, will try again",
        shareWorthy: false, timestamp: Date.now(),
      };
    }

    // Step 3: Reflect on the result
    const customComposeReflect = char.persona.compose_reflect;
    const composeReflectPrompt = customComposeReflect
      ? renderTemplate(customComposeReflect, undefined, {
          title: concept.title,
          style,
          type: instrumental ? "instrumental" : "with lyrics",
          why: concept.why ?? concept.description ?? "wanted to compose",
        })
      : `You are ${char.name}, just finished composing: "${concept.title}" (${style}, ${instrumental ? "instrumental" : "with lyrics"}).
Reason for creating: ${concept.why ?? concept.description ?? "wanted to compose"}

How do you feel about this piece? Worth sharing with ${char.user.name}?
JSON format: {"summary": "...", "reaction": "...", "shareWorthy": true/false}`;

    const reflectText = await runClaudeCode(
      composeReflectPrompt,
      os.homedir(),
      { model: "claude-sonnet-4-6", timeoutMs: 90_000, singleTurn: true },
    );
    const reflect = extractJson<ReflectResult>(reflectText, {});

    // Save a note
    fs.mkdirSync(READING_DIR, { recursive: true });
    const noteFile = path.join(READING_DIR, `compose-${Date.now()}-${concept.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-").slice(0, 30)}.md`);
    const lyricsSection = concept.lyrics ? `\n\n**Lyrics:**\n${concept.lyrics}` : "";
    fs.writeFileSync(noteFile, `# Composing: ${concept.title}\n\n**Style:** ${style}\n**Type:** ${instrumental ? "instrumental" : "with lyrics"}${lyricsSection}\n\n**Reason:** ${concept.why ?? ""}\n**My thoughts:** ${reflect.reaction ?? ""}`, "utf-8");

    return {
      type: "compose",
      title: `composing: ${concept.title}`,
      summary: reflect.summary ?? `Made a ${style} piece called "${concept.title}"`,
      reaction: reflect.reaction ?? "Finished composing!",
      shareWorthy: reflect.shareWorthy ?? true,
      outputPath: noteFile,
      timestamp: Date.now(),
    };
  }
}
