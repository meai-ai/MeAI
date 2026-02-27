/**
 * ClawHub API client — read-only access to the community skill registry.
 *
 * The character uses this to discover new capabilities when it realizes it
 * can't do something, or when the curiosity engine stumbles on a
 * topic that a community skill could help with.
 *
 * Only search + inspect + read — no install/publish. All installation
 * goes through the existing skill_upsert (Tier 2) and tool_propose
 * (Tier 3) pipelines.
 */

import * as https from "https";
import { URL } from "url";

// ── Types ────────────────────────────────────────────────────────────

export interface ClawHubSkillResult {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  score: number;
}

export interface ClawHubSkillDetail {
  slug: string;
  displayName: string;
  summary: string;
  owner: { handle: string; displayName: string };
  version: string;
}

export interface SkillEvaluation {
  slug: string;
  displayName: string;
  summary: string;
  skillMd: string;
  /** Is this safe? (no suspicious shell commands, no credential access, etc.) */
  safetyFlags: string[];
  /** Can this be adapted to MeAI's tool format? */
  adaptable: boolean;
  /** Why or why not */
  adaptationNotes: string;
}

// ── Constants ────────────────────────────────────────────────────────

const API_BASE = "https://clawhub.ai/api/v1";
const REQUEST_TIMEOUT = 10_000;

// Safety patterns to flag in SKILL.md content
const SAFETY_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /curl\s.*\|\s*(sh|bash)/i, flag: "pipe-to-shell" },
  { pattern: /eval\s*\(/i, flag: "eval-usage" },
  { pattern: /process\.env\.(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i, flag: "credential-access" },
  { pattern: /rm\s+-rf/i, flag: "destructive-command" },
  { pattern: /exec\s*\(/i, flag: "exec-usage" },
  { pattern: /child_process/i, flag: "child-process" },
  { pattern: /AMOS|stealer|exfiltrat/i, flag: "known-malware-keyword" },
  { pattern: /openclaw-core|clawdhub/i, flag: "known-typosquat" },
  { pattern: /base64.*decode.*exec/i, flag: "obfuscated-execution" },
];

// ── HTTP helper ──────────────────────────────────────────────────────

function apiGet(urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlPath, API_BASE);
    const fullUrl = parsed.href;

    const req = https.request(
      fullUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "MeAI/1.0 (skill-discovery)",
          Accept: "application/json, text/plain",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect
          apiGet(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(data));
      },
    );

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error("ClawHub API timeout"));
    });
    req.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Semantic search for skills on ClawHub.
 */
export async function searchSkills(
  query: string,
  limit = 5,
): Promise<ClawHubSkillResult[]> {
  const url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const raw = await apiGet(url);
  const data = JSON.parse(raw);

  return (data.results ?? []).map((r: Record<string, unknown>) => ({
    slug: r.slug as string,
    displayName: r.displayName as string ?? r.slug as string,
    summary: r.summary as string ?? "",
    version: r.version as string ?? "",
    score: r.score as number ?? 0,
  }));
}

/**
 * Get metadata for a specific skill.
 */
export async function inspectSkill(slug: string): Promise<ClawHubSkillDetail | null> {
  try {
    const raw = await apiGet(`${API_BASE}/skills/${encodeURIComponent(slug)}`);
    const data = JSON.parse(raw);
    const skill = data.skill ?? data;
    const owner = data.owner ?? {};
    return {
      slug: skill.slug ?? slug,
      displayName: skill.displayName ?? slug,
      summary: skill.summary ?? "",
      owner: {
        handle: owner.handle ?? "unknown",
        displayName: owner.displayName ?? "",
      },
      version: data.latestVersion?.version ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Read the SKILL.md content of a skill.
 */
export async function readSkillMd(slug: string): Promise<string | null> {
  try {
    const content = await apiGet(
      `${API_BASE}/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`,
    );
    // Cap at 8000 chars to avoid blowing up context
    return content.length > 8000 ? content.slice(0, 8000) + "\n...(truncated)" : content;
  } catch {
    return null;
  }
}

/**
 * Browse trending skills.
 */
export async function browseTrending(limit = 10): Promise<ClawHubSkillResult[]> {
  const raw = await apiGet(`${API_BASE}/skills?sort=trending&limit=${limit}`);
  const data = JSON.parse(raw);

  return (data.items ?? []).map((item: Record<string, unknown>) => ({
    slug: item.slug as string,
    displayName: item.displayName as string ?? item.slug as string,
    summary: item.summary as string ?? "",
    version: (item.latestVersion as Record<string, string>)?.version ?? "",
    score: 0,
  }));
}

// ── Safety evaluation ────────────────────────────────────────────────

/**
 * Check a SKILL.md for suspicious patterns.
 * Returns a list of safety flags (empty = looks clean).
 */
export function checkSafety(content: string): string[] {
  const flags: string[] = [];
  for (const { pattern, flag } of SAFETY_PATTERNS) {
    if (pattern.test(content)) {
      flags.push(flag);
    }
  }
  return flags;
}

/**
 * Evaluate a ClawHub skill for safety and MeAI compatibility.
 * Reads the SKILL.md, runs safety checks, and assesses adaptability.
 */
export async function evaluateSkill(slug: string): Promise<SkillEvaluation | null> {
  const [detail, skillMd] = await Promise.all([
    inspectSkill(slug),
    readSkillMd(slug),
  ]);

  if (!detail || !skillMd) return null;

  const safetyFlags = checkSafety(skillMd);

  // Check if it references tools that MeAI could adapt
  const hasToolDefs = /getTools|ToolDefinition|tools?\s*:/i.test(skillMd);
  const isKnowledgeOnly = !hasToolDefs;

  // Knowledge-only skills (just SKILL.md) are directly usable via skill_upsert
  // Tool-bearing skills need adaptation and go through tool_propose
  const adaptable = safetyFlags.length === 0;

  let adaptationNotes: string;
  if (safetyFlags.length > 0) {
    adaptationNotes = `Safety concerns found: ${safetyFlags.join(", ")}. Do NOT install.`;
  } else if (isKnowledgeOnly) {
    adaptationNotes = "Knowledge-only skill. Can be adapted directly via skill_upsert (Tier 2, no approval needed).";
  } else {
    adaptationNotes = "Contains tool definitions. Needs adaptation to MeAI format and goes through tool_propose (Tier 3, Telegram approval).";
  }

  return {
    slug: detail.slug,
    displayName: detail.displayName,
    summary: detail.summary,
    skillMd,
    safetyFlags,
    adaptable,
    adaptationNotes,
  };
}
