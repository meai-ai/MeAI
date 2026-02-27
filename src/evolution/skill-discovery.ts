/**
 * Skill Discovery — lets the character search ClawHub for new capabilities.
 *
 * Two tools:
 * - clawhub_search: Search the ClawHub registry for skills matching a query
 * - clawhub_evaluate: Read and evaluate a specific skill for safety + compatibility
 *
 * After discovering a useful skill, the character uses the existing pipelines:
 * - skill_upsert (Tier 2) for knowledge-only adaptations
 * - tool_propose (Tier 3) for executable tools (requires Telegram approval)
 */

import type { AppConfig, ToolDefinition } from "../types.js";
import {
  searchSkills,
  browseTrending,
  evaluateSkill,
  type SkillEvaluation,
} from "../clawhub.js";

/**
 * Format search results for the agent.
 */
function formatSearchResults(
  results: Array<{ slug: string; displayName: string; summary: string; score: number }>,
): string {
  if (results.length === 0) return "No matching skills found on ClawHub.";

  return results
    .map((r, i) =>
      `${i + 1}. ${r.displayName} (${r.slug}) — ${r.summary}${r.score > 0 ? ` [relevance: ${(r.score * 100).toFixed(0)}%]` : ""}`,
    )
    .join("\n");
}

/**
 * Format evaluation for the agent.
 */
function formatEvaluation(ev: SkillEvaluation): string {
  const sections: string[] = [];

  sections.push(`Skill: ${ev.displayName} (${ev.slug})`);
  sections.push(`Summary: ${ev.summary}`);
  sections.push(`Safety: ${ev.safetyFlags.length === 0 ? "CLEAN — no issues detected" : `WARNING — ${ev.safetyFlags.join(", ")}`}`);
  sections.push(`Adaptable: ${ev.adaptable ? "Yes" : "No"}`);
  sections.push(`Notes: ${ev.adaptationNotes}`);
  sections.push("");
  sections.push("--- SKILL.md content ---");
  sections.push(ev.skillMd);

  return sections.join("\n");
}

export function getSkillDiscoveryTools(config: AppConfig): ToolDefinition[] {
  const clawHubSearch: ToolDefinition = {
    name: "clawhub_search",
    description:
      "Search the ClawHub community skill registry for new capabilities. " +
      "Use this when you realize you can't do something and want to see if " +
      "a community skill exists. You can also browse trending skills. " +
      "Results show skill name, slug, and summary. To read the full skill " +
      "content, use clawhub_evaluate with the slug.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query describing the capability you need. " +
            "E.g., 'read PDF files', 'track expenses', 'control smart home'. " +
            "Leave empty and set mode to 'trending' to browse popular skills.",
        },
        mode: {
          type: "string",
          enum: ["search", "trending"],
          description: "Search mode: 'search' for semantic query, 'trending' for popular skills. Default: search.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (1-10, default 5)",
        },
      },
      required: [],
    },
    execute: async (input) => {
      const query = (input.query as string) ?? "";
      const mode = (input.mode as string) ?? "search";
      const limit = Math.min(Math.max((input.limit as number) ?? 5, 1), 10);

      try {
        if (mode === "trending") {
          const results = await browseTrending(limit);
          return `Trending skills on ClawHub:\n\n${formatSearchResults(results)}`;
        }

        if (!query) {
          return "Error: query is required for search mode.";
        }

        const results = await searchSkills(query, limit);
        return `ClawHub search results for "${query}":\n\n${formatSearchResults(results)}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `ClawHub search failed: ${msg}`;
      }
    },
  };

  const clawHubEvaluate: ToolDefinition = {
    name: "clawhub_evaluate",
    description:
      "Read and evaluate a specific ClawHub skill. Fetches the full SKILL.md, " +
      "runs safety checks (flags suspicious patterns like shell piping, credential access, " +
      "known malware keywords), and assesses whether it can be adapted to MeAI's format. " +
      "After evaluation, you can: " +
      "(1) Adapt a knowledge-only skill directly with skill_upsert (Tier 2, no approval). " +
      "(2) Adapt a tool-bearing skill and propose it with tool_propose (Tier 3, needs Telegram approval). " +
      "(3) Skip if safety flags are present.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The skill slug from ClawHub search results (e.g., 'gifgrep', 'expense-tracker')",
        },
      },
      required: ["slug"],
    },
    execute: async (input) => {
      const slug = input.slug as string;

      if (!slug) {
        return "Error: slug is required.";
      }

      try {
        const evaluation = await evaluateSkill(slug);
        if (!evaluation) {
          return `Could not evaluate skill "${slug}" — it may not exist or the API may be unavailable.`;
        }

        return formatEvaluation(evaluation);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `ClawHub evaluation failed for "${slug}": ${msg}`;
      }
    },
  };

  return [clawHubSearch, clawHubEvaluate];
}
