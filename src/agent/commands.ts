/**
 * Slash commands — extracted from AgentLoop.
 *
 * Each command is a standalone function receiving only the deps it needs.
 */

import type { AppConfig } from "../types.js";
import type { SessionManager } from "../session/manager.js";
import type { SkillSelection } from "./skill-router.js";
import { loadSkills } from "./context.js";
import { getStoreManager } from "../memory/store-manager.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("commands");

/**
 * Handle slash commands. Returns response text if handled, null otherwise.
 */
export async function handleSlashCommand(
  text: string,
  session: SessionManager,
  config: AppConfig,
  usageReport: () => string,
  lastSkillSelection: SkillSelection | null,
): Promise<string | null> {
  const trimmed = text.trim();
  const cmd = trimmed.toLowerCase();

  if (cmd === "/status") return getStatusReport(session, config, lastSkillSelection);
  if (cmd === "/memory") return getMemoryReport();
  if (cmd === "/skills") return getSkillsReport(config.statePath, lastSkillSelection);
  if (cmd === "/usage") return usageReport();
  if (cmd === "/sessions") return getSessionsReport(session);
  if (cmd === "/new") return handleNewSession(session);
  if (cmd.startsWith("/recall")) {
    const query = trimmed.slice("/recall".length).trim();
    return handleRecall(query, session);
  }

  return null;
}

function getStatusReport(session: SessionManager, config: AppConfig, lastSkillSelection: SkillSelection | null): string {
  const tokenEstimate = session.estimateTokens();
  const usage = ((tokenEstimate / config.maxContextTokens) * 100).toFixed(1);

  const entries = session.loadAll();
  const memoryCount = loadMemoryCount();
  const skills = loadSkills(config.statePath);
  const archivedSessions = session.getIndex().listAll();

  const lines = [
    "📊 *MeAI Status*",
    "",
    `*Model:* ${config.model}`,
    `*Context usage:* ~${tokenEstimate} tokens (${usage}% of ${config.maxContextTokens})`,
    `*Compaction at:* ${(config.compactionThreshold * 100).toFixed(0)}%`,
    `*Transcript entries:* ${entries.length}`,
    `*Archived sessions:* ${archivedSessions.length}`,
    `*Memories stored:* ${memoryCount}`,
    `*Skills available:* ${skills.length}${lastSkillSelection ? ` (${lastSkillSelection.selected.length} active last turn)` : ""}`,
    `*State path:* \`${config.statePath}\``,
  ];

  return lines.join("\n");
}

function getMemoryReport(): string {
  try {
    const memories = getStoreManager().loadAll();

    if (memories.length === 0) {
      return "No memories stored yet.";
    }

    const lines = ["🧠 *Stored Memories*", ""];
    for (const m of memories) {
      const date = new Date(m.timestamp).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
      lines.push(`• *${m.key}*: ${m.value} (conf: ${m.confidence}, ${date})`);
    }

    return lines.join("\n");
  } catch (err) {
    log.warn("failed to read memory store", err);
    return "Error reading memory store.";
  }
}

function getSkillsReport(statePath: string, lastSkillSelection: SkillSelection | null): string {
  const skills = loadSkills(statePath);

  if (skills.length === 0) {
    return "No skills defined yet.";
  }

  const lines = ["📚 *Skills* (progressive loading)", ""];

  if (lastSkillSelection) {
    const { selected, scores } = lastSkillSelection;
    const activeNames = new Set(selected.map((s) => s.name));

    lines.push(`*Active this turn (${selected.length}):*`);
    for (const s of selected) {
      const scoreEntry = scores.find((sc) => sc.skill.name === s.name);
      const scoreStr = scoreEntry ? ` (score: ${scoreEntry.score.toFixed(2)})` : "";
      const toolsTag = s.hasTools ? " ⚙️" : "";
      lines.push(`  ✦ ${s.name}${toolsTag}${scoreStr}`);
    }

    const inactive = skills.filter((s) => !activeNames.has(s.name));
    if (inactive.length > 0) {
      lines.push("");
      lines.push(`*Available but not loaded (${inactive.length}):*`);
      for (const s of inactive) {
        const scoreEntry = scores.find((sc) => sc.skill.name === s.name);
        const scoreStr = scoreEntry ? ` (score: ${scoreEntry.score.toFixed(2)})` : "";
        const toolsTag = s.hasTools ? " ⚙️" : "";
        lines.push(`  ○ ${s.name}${toolsTag}${scoreStr}`);
      }
    }
  } else {
    for (const s of skills) {
      const toolsTag = s.hasTools ? " ⚙️" : "";
      lines.push(`• ${s.name}${toolsTag}: ${s.content.slice(0, 80)}...`);
    }
  }

  lines.push("");
  lines.push(`*Total:* ${skills.length} skills`);

  return lines.join("\n");
}

function getSessionsReport(session: SessionManager): string {
  const sessions = session.getIndex().listAll();

  if (sessions.length === 0) {
    return "No archived sessions yet. Sessions are archived automatically during compaction, or manually with /new.";
  }

  const lines = ["📂 *Archived Sessions*", ""];
  for (const s of sessions) {
    const date = new Date(s.updatedAt).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
    lines.push(`• *${s.slug}* — ${s.title}`);
    lines.push(`  ${date} · ${s.messageCount} msgs · ${s.topics.join(", ")}`);
    if (s.summary) {
      const preview = s.summary.length > 120 ? s.summary.slice(0, 120) + "…" : s.summary;
      lines.push(`  _${preview}_`);
    }
    lines.push("");
  }

  lines.push("Use `/recall <query>` to search and load a past session's context.");
  return lines.join("\n");
}

async function handleNewSession(session: SessionManager): Promise<string> {
  const result = await session.startNewSession();

  if (result) {
    return `✅ Session archived as *${result.slug}* ("${result.title}").\n\nFresh session started. Use /sessions to browse past conversations.`;
  }
  return "✅ Fresh session started. (Previous session was too short to archive.)";
}

function handleRecall(query: string, session: SessionManager): string {
  if (!query) {
    return "Usage: `/recall <query>`\n\nSearch past sessions by topic, slug, or keyword. Example: `/recall react hooks`";
  }

  const results = session.getIndex().search(query);

  if (results.length === 0) {
    return `No archived sessions match "${query}". Use /sessions to see all available sessions.`;
  }

  const lines = [`🔍 *Sessions matching "${query}":*`, ""];
  for (const s of results.slice(0, 5)) {
    const date = new Date(s.updatedAt).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
    lines.push(`*${s.slug}* — ${s.title} (${date})`);
    lines.push(`Topics: ${s.topics.join(", ")}`);
    if (s.summary) {
      lines.push(`${s.summary}`);
    }
    lines.push("");
  }

  if (results.length > 5) {
    lines.push(`_…and ${results.length - 5} more results._`);
  }

  return lines.join("\n");
}

function loadMemoryCount(): number {
  try {
    return getStoreManager().count();
  } catch (err) {
    log.warn("failed to count memories", err);
    return 0;
  }
}
