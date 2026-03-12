/**
 * Research Engine — autonomous research system for the character.
 *
 * Manages multiple research tracks (MeAI evolution, projects, long-term research).
 * Each track has its own goal, constitution, journal, and optional target repo.
 *
 * Phase 1: observe → journal (single track: meai-evolution)
 * Phase 2: interact with users via Telegram
 * Phase 3: research + code patches (PRs)
 * Phase 4: multi-track + debate
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { claudeText } from "./claude-runner.js";
import { createLogger } from "./lib/logger.js";
import type { AppConfig } from "./types.js";

const log = createLogger("research");

// ── Types ─────────────────────────────────────────────────────────────

export interface ResearchTrack {
  id: string;
  kind: "evolution" | "project" | "research" | "maintenance";
  goal: string;
  status: "active" | "paused" | "completed";
  constitution?: string;
  target_repo?: string;
  telegram_chat_id?: number;
  journal_file: string;
  priority: number;
  created_at: number;
  last_active_at: number;
  current_question?: string;
  blocked_reason?: string;
  notes: string;
}

export interface ResearchJournalEntry {
  id: string;
  track_id: string;
  timestamp: number;
  duration_ms: number;
  checkpoint_ref: string;
  question: string;
  why_now: string;
  observation: {
    sources: Array<{
      type: "code" | "runtime" | "conversation" | "web" | "paper";
      ref: string;
    }>;
    patterns_noticed: string[];
    key_findings: string;
  };
  interaction: {
    target: string;
    messages_sent: number;
    messages_received: number;
    observations: string[];
    transcript_summary: string;
  } | null;
  research_notes: string[];
  debate_summary: string;
  action: {
    type: "patch" | "document" | "knowledge_update" | "none";
    pr_url?: string;
    files_changed?: string[];
    description: string;
  };
  expected_effect: string;
  confidence: number;
  next_step: string;
  category: "bug_fix" | "feature" | "refactor" | "observation" | "research_only" | "literature_review" | "experiment";
  interrupted?: boolean;
}

// ── State ────────────────────────────────────────────────────────────

let statePath = "";

interface TracksFile {
  tracks: ResearchTrack[];
}

// ── Init ─────────────────────────────────────────────────────────────

export function initResearch(sp: string): void {
  statePath = sp;
  // Ensure directories
  const dirs = [
    path.join(sp, "research"),
    path.join(sp, "research", "constitutions"),
    path.join(sp, "research", "journals"),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Track Management ─────────────────────────────────────────────────

function loadTracks(): ResearchTrack[] {
  const p = path.join(statePath, "research", "tracks.json");
  const data = readJsonSafe<TracksFile>(p, { tracks: [] });
  return data.tracks;
}

function saveTracks(tracks: ResearchTrack[]): void {
  const p = path.join(statePath, "research", "tracks.json");
  writeJsonAtomic(p, { tracks });
}

function selectTrack(tracks: ResearchTrack[]): ResearchTrack | null {
  const active = tracks.filter(t => t.status === "active" && !t.blocked_reason);
  if (active.length === 0) return null;

  // Weighted selection: priority * staleness
  const now = Date.now();
  let best: ResearchTrack | null = null;
  let bestScore = -1;
  for (const t of active) {
    const staleness = Math.min((now - t.last_active_at) / (24 * 60 * 60 * 1000), 7); // cap at 7 days
    const score = t.priority * (1 + staleness);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ── Git Checkpoint ───────────────────────────────────────────────────

function getCheckpointRef(): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: path.resolve(statePath, ".."),
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── Observe ──────────────────────────────────────────────────────────

interface ObservationResult {
  sources: Array<{ type: "code" | "runtime" | "conversation"; ref: string }>;
  patterns_noticed: string[];
  key_findings: string;
  question: string;
  why_now: string;
}

async function observe(track: ResearchTrack): Promise<ObservationResult> {
  // Gather source material based on track kind
  const sources: Array<{ type: "code" | "runtime" | "conversation"; ref: string }> = [];
  let sourceContext = "";

  if (track.kind === "evolution") {
    // Read key source files from the target repo (or own repo)
    const repoPath = track.target_repo
      ? path.resolve(track.target_repo.replace("~", process.env.HOME || ""))
      : path.resolve(statePath, "..");

    const filesToRead = [
      "src/agent/context.ts",
      "src/emotion.ts",
      "src/proactive.ts",
      "src/heartbeat.ts",
      "src/agent/loop.ts",
    ];

    for (const f of filesToRead) {
      const fullPath = path.join(repoPath, f);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          // Only include first 200 lines to keep context manageable
          const lines = content.split("\n").slice(0, 200).join("\n");
          sourceContext += `\n--- ${f} (first 200 lines) ---\n${lines}\n`;
          sources.push({ type: "code", ref: f });
        } catch { /* skip */ }
      }
    }

    // Read recent runtime logs (heartbeat)
    const heartbeatLogDir = path.join(statePath, "heartbeat");
    try {
      const logFiles = fs.readdirSync(heartbeatLogDir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .slice(-1);
      for (const lf of logFiles) {
        const lines = fs.readFileSync(path.join(heartbeatLogDir, lf), "utf-8")
          .split("\n")
          .filter(Boolean)
          .slice(-20);
        sourceContext += `\n--- heartbeat log (last 20 entries) ---\n${lines.join("\n")}\n`;
        sources.push({ type: "runtime", ref: `heartbeat/${lf}` });
      }
    } catch { /* ok */ }

    // Read recent emotion journal
    const emotionPath = path.join(statePath, "emotion-journal.json");
    if (fs.existsSync(emotionPath)) {
      try {
        const emotionData = JSON.parse(fs.readFileSync(emotionPath, "utf-8"));
        const recentEntries = (emotionData.entries || []).slice(-5);
        sourceContext += `\n--- emotion journal (last 5 entries) ---\n${JSON.stringify(recentEntries, null, 2)}\n`;
        sources.push({ type: "runtime", ref: "emotion-journal.json" });
      } catch { /* ok */ }
    }
  }

  // Load constitution if available
  let constitutionText = "";
  if (track.constitution) {
    const constPath = path.join(statePath, "..", track.constitution);
    if (fs.existsSync(constPath)) {
      constitutionText = fs.readFileSync(constPath, "utf-8");
    }
  }

  // Load previous journal entries for continuity
  let previousContext = "";
  const journalPath = path.join(statePath, "..", track.journal_file);
  if (fs.existsSync(journalPath)) {
    try {
      const entries = fs.readFileSync(journalPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .slice(-3)
        .map(line => {
          try { return JSON.parse(line) as ResearchJournalEntry; } catch { return null; }
        })
        .filter(Boolean) as ResearchJournalEntry[];

      if (entries.length > 0) {
        previousContext = entries.map(e =>
          `[${new Date(e.timestamp).toISOString()}] Question: ${e.question}\nFindings: ${e.observation.key_findings}\nNext step: ${e.next_step}`
        ).join("\n\n");
      }
    } catch { /* ok */ }
  }

  const currentQuestion = track.current_question
    ? `Previous research question: ${track.current_question}\n`
    : "";

  const system = `You are the research observation module. Your task is:
1. Carefully read the provided source code and runtime logs
2. Discover specific issues or improvement opportunities in MeAI companion quality
3. Propose a real, specific, non-vague research question

${constitutionText ? `Research guidelines:\n${constitutionText}\n` : ""}

Requirements:
- Observations must be specific to code behavior, log patterns, conversation quality
- Don't say vague things like "overall good"
- Questions must be actionable and verifiable
- If there's a previous unfinished research question, you may continue deeper

Reply format (JSON):
{
  "patterns_noticed": ["specific pattern 1", "specific pattern 2"],
  "key_findings": "Most important finding, one or two sentences",
  "question": "Specific question to research this round",
  "why_now": "Why research this now"
}`;

  const prompt = `${currentQuestion}${previousContext ? `Previous research records:\n${previousContext}\n\n` : ""}Current source code and logs:\n${sourceContext}`;

  const result = await claudeText({
    system,
    prompt,
    model: "smart",
    timeoutMs: 60_000,
    maxOutputChars: 4000,
    label: "research.observe",
  });

  try {
    // Extract JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      sources,
      patterns_noticed: parsed.patterns_noticed || [],
      key_findings: parsed.key_findings || "No clear findings",
      question: parsed.question || "Needs further observation",
      why_now: parsed.why_now || "Routine research",
    };
  } catch {
    log.warn("Failed to parse observation result, using raw text");
    return {
      sources,
      patterns_noticed: [],
      key_findings: result.slice(0, 500),
      question: track.current_question || "Needs further observation",
      why_now: "Routine research",
    };
  }
}

// ── Journal ──────────────────────────────────────────────────────────

function writeJournal(
  track: ResearchTrack,
  checkpoint: string,
  observation: ObservationResult,
  durationMs: number,
  interrupted = false,
): ResearchJournalEntry {
  const entry: ResearchJournalEntry = {
    id: `research-${Date.now()}`,
    track_id: track.id,
    timestamp: Date.now(),
    duration_ms: durationMs,
    checkpoint_ref: checkpoint,
    question: observation.question,
    why_now: observation.why_now,
    observation: {
      sources: observation.sources,
      patterns_noticed: observation.patterns_noticed,
      key_findings: observation.key_findings,
    },
    interaction: null, // Phase 2
    research_notes: [],
    debate_summary: "",
    action: { type: "none", description: "Phase 1: observe only" },
    expected_effect: "",
    confidence: 0.5,
    next_step: observation.question, // carry forward as next question
    category: "observation",
    interrupted,
  };

  const journalPath = path.join(statePath, "..", track.journal_file);
  fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n");

  return entry;
}

// ── Research Engine ──────────────────────────────────────────────────

export class ResearchEngine {
  private config: AppConfig;
  private running = false;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * One research tick — called by heartbeat during night hours.
   * Select track → checkpoint → observe → journal.
   */
  async tick(): Promise<boolean> {
    if (this.running) {
      log.info("Research already running, skipping");
      return false;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      // 1. Select track
      const tracks = loadTracks();
      const track = selectTrack(tracks);
      if (!track) {
        log.info("No active research tracks");
        return false;
      }
      log.info(`Selected track: ${track.id} (priority=${track.priority})`);

      // 2. Checkpoint
      const checkpoint = getCheckpointRef();
      log.info(`Checkpoint: ${checkpoint.slice(0, 8)}`);

      // 3. Observe
      log.info("Observing...");
      const observation = await observe(track);
      log.info(`Observation: ${observation.key_findings.slice(0, 100)}`);
      log.info(`Question: ${observation.question}`);

      // 4. Write journal
      const durationMs = Date.now() - startTime;
      const entry = writeJournal(track, checkpoint, observation, durationMs);
      log.info(`Journal entry: ${entry.id}`);

      // 5. Update track state
      track.last_active_at = Date.now();
      track.current_question = observation.question;
      saveTracks(tracks);

      return true;
    } catch (err) {
      log.error("Research tick failed:", err);
      return false;
    } finally {
      this.running = false;
    }
  }

  /** Get recent journal entries for context injection. */
  getRecentJournals(trackId?: string, count = 3): ResearchJournalEntry[] {
    const tracks = loadTracks();
    const targetTracks = trackId
      ? tracks.filter(t => t.id === trackId)
      : tracks.filter(t => t.status === "active");

    const entries: ResearchJournalEntry[] = [];
    for (const track of targetTracks) {
      const journalPath = path.join(statePath, "..", track.journal_file);
      if (!fs.existsSync(journalPath)) continue;
      try {
        const lines = fs.readFileSync(journalPath, "utf-8")
          .split("\n")
          .filter(Boolean)
          .slice(-count);
        for (const line of lines) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      } catch { /* ok */ }
    }

    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, count);
  }

  /** Get all tracks for status display. */
  getTracks(): ResearchTrack[] {
    return loadTracks();
  }
}

// ── Context Formatting (for system prompt injection) ─────────────────

export function formatResearchContext(): string {
  const tracks = loadTracks();
  const active = tracks.filter(t => t.status === "active");
  if (active.length === 0) return "";

  const lines = ["## Research Activity"];
  for (const t of active) {
    lines.push(`- **${t.id}** (${t.kind}): ${t.goal}`);
    if (t.current_question) {
      lines.push(`  Current question: ${t.current_question}`);
    }
    if (t.blocked_reason) {
      lines.push(`  Blocked: ${t.blocked_reason}`);
    }
  }

  // Add latest journal finding
  const journalPath = path.join(statePath, "..", active[0].journal_file);
  if (fs.existsSync(journalPath)) {
    try {
      const lastLine = fs.readFileSync(journalPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .pop();
      if (lastLine) {
        const entry = JSON.parse(lastLine) as ResearchJournalEntry;
        const age = Math.round((Date.now() - entry.timestamp) / (60 * 60 * 1000));
        lines.push(`\nRecent finding (${age}h ago): ${entry.observation.key_findings}`);
      }
    } catch { /* ok */ }
  }

  return lines.join("\n");
}
