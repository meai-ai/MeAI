/**
 * Repository Work Tools — Git workflow for MeAI researcher agents.
 *
 * Each researcher bot has its own git worktree.
 * All write operations check global mode before executing.
 * Forbidden paths are enforced at the tool level (protocol layer).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// Import store for mode enforcement and agenda checks
import {
  enforceWriteMode,
  readAgenda,
  readMode,
} from "../../../src/researcher/store.js";

// ── Config Helpers ─────────────────────────────────────────────────

function getBotName(config: any): string {
  return config?.botName ?? "unknown";
}

function getWorktreePath(config: any): string {
  const root = config?.researcherDataRoot ?? "/Users/allen/Documents/MeAI_data";
  const bot = getBotName(config).toLowerCase();
  return join(root, "worktrees", bot);
}

function getRepoRoot(): string {
  // The main MeAI repo root (parent of src/)
  return resolve(new URL(".", import.meta.url).pathname, "../../../");
}

// ── Forbidden Path Check ───────────────────────────────────────────

const FORBIDDEN_PATTERNS = [
  // Security surface
  /^data\/config.*\.json$/,
  /^\.env/,
  /^\.oauth-tokens\.json$/,
  /^deploy\//,
  /^\.github\/workflows\//,
  // Governance core
  /^src\/agent\/loop\.ts$/,
  /^src\/channel\//,
  /^src\/config\.ts$/,
  /^src\/registry\//,
  /^data\/skills\/research-coord\/tools\.ts$/,
];

function isForbiddenPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, "");
  return FORBIDDEN_PATTERNS.some(p => p.test(normalized));
}

// ── Implement Gate Check ───────────────────────────────────────────

/**
 * Verify all implement preconditions (design Phase 4 gate).
 * Returns null if OK, or an error string if blocked.
 */
function checkImplementGate(botName: string, topicId?: string): string | null {
  enforceWriteMode(); // throws if not normal

  if (!topicId) return null; // Some tools don't require a topic

  const { data } = readAgenda();
  const topic = data.topics.find(t => t.id === topicId);
  if (!topic) return `Topic ${topicId} not found`;
  if (!["claimed", "implementing"].includes(topic.status)) {
    return `Topic ${topicId} is ${topic.status}, must be 'claimed' or 'implementing'`;
  }
  if (topic.owner !== botName) {
    return `Topic ${topicId} is owned by ${topic.owner}, not ${botName}`;
  }
  if (topic.leaseUntil && topic.leaseUntil < Date.now()) {
    return `Lease expired for topic ${topicId}. Renew first.`;
  }
  return null;
}

// ── Diff Budget Check ──────────────────────────────────────────────

const MAX_FILES = 10;
const MAX_LINES = 500;

interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  totalLines: number;
}

function getDiffStats(worktree: string): DiffStats {
  try {
    const raw = execSync("git diff --stat HEAD", {
      cwd: worktree,
      encoding: "utf-8",
      timeout: 10000,
    });
    const lines = raw.trim().split("\n");
    // Last line is summary: " N files changed, X insertions(+), Y deletions(-)"
    const summary = lines[lines.length - 1] || "";
    const filesMatch = summary.match(/(\d+) files? changed/);
    const addMatch = summary.match(/(\d+) insertions?\(\+\)/);
    const delMatch = summary.match(/(\d+) deletions?\(-\)/);
    const files = filesMatch ? parseInt(filesMatch[1]) : 0;
    const additions = addMatch ? parseInt(addMatch[1]) : 0;
    const deletions = delMatch ? parseInt(delMatch[1]) : 0;
    return { files, additions, deletions, totalLines: additions + deletions };
  } catch {
    return { files: 0, additions: 0, deletions: 0, totalLines: 0 };
  }
}

// ── Shell Helper ───────────────────────────────────────────────────

function git(cmd: string, cwd: string, timeoutMs = 30000): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
}

// ── Tool Definitions ───────────────────────────────────────────────

export function getTools(config?: any): any[] {
  const botName = getBotName(config);
  const worktree = getWorktreePath(config);
  const repoRoot = getRepoRoot();

  return [
    // ── create_work_branch ───────────────────────────────────────
    {
      name: "repo_create_branch",
      description: "Create a new feature branch from main for a topic. Sets up the git worktree if needed.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          slug: { type: "string", description: "Short kebab-case description, e.g. 'fix-memory-leak'" },
        },
        required: ["topicId", "slug"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;
        const slug = input.slug as string;

        // Implement gate: verify topic ownership + lease + mode
        const gateErr = checkImplementGate(botName, topicId);
        if (gateErr) return JSON.stringify({ success: false, error: gateErr });

        const branchName = `${botName.toLowerCase()}/topic-${topicId}-${slug}`;

        try {
          // Ensure worktree exists
          if (!existsSync(worktree)) {
            mkdirSync(worktree, { recursive: true });
            git(`worktree add "${worktree}" -b "${branchName}" main`, repoRoot);
          } else {
            // Worktree exists, create branch from latest main
            git("fetch origin main", worktree);
            git(`checkout -b "${branchName}" origin/main`, worktree);
          }

          return JSON.stringify({ success: true, branch: branchName, worktree });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── edit_file ────────────────────────────────────────────────
    {
      name: "repo_edit_file",
      description: "Edit a file in the worktree. Forbidden paths (security + governance) are blocked.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Relative path from repo root" },
          content: { type: "string", description: "New file content" },
        },
        required: ["filePath", "content"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        enforceWriteMode();

        const filePath = input.filePath as string;
        const content = input.content as string;

        if (isForbiddenPath(filePath)) {
          return JSON.stringify({ success: false, error: `Forbidden path: ${filePath}` });
        }

        try {
          const fullPath = join(worktree, filePath);
          const dir = join(fullPath, "..");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(fullPath, content);
          return JSON.stringify({ success: true, filePath, bytes: content.length });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── show_diff ────────────────────────────────────────────────
    {
      name: "repo_show_diff",
      description: "Show the current git diff in the worktree.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: async (): Promise<string> => {
        try {
          const diff = git("diff", worktree, 10000);
          const stats = getDiffStats(worktree);
          return JSON.stringify({
            success: true,
            stats,
            diff: diff.length > 5000 ? diff.slice(0, 5000) + "\n... (truncated)" : diff,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── run_tests ────────────────────────────────────────────────
    {
      name: "repo_run_tests",
      description: "Run typecheck and smoke tests. Must pass before opening a PR.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: async (): Promise<string> => {
        const results: { typecheck: boolean; error?: string } = { typecheck: false };

        try {
          execSync("npx tsc --noEmit", {
            cwd: worktree,
            encoding: "utf-8",
            timeout: 60000,
          });
          results.typecheck = true;
        } catch (err: any) {
          results.error = err.stdout || err.message;
        }

        return JSON.stringify({ success: results.typecheck, ...results });
      },
    },

    // ── commit_and_push ──────────────────────────────────────────
    {
      name: "repo_commit_and_push",
      description: "Stage all changes, commit with a message, and push to remote.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
        },
        required: ["message"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        enforceWriteMode();

        const message = input.message as string;

        try {
          git("add -A", worktree);

          // Check for forbidden paths in staged changes
          const staged = git("diff --cached --name-only", worktree);
          const stagedFiles = staged.split("\n").filter(Boolean);
          const forbidden = stagedFiles.filter(isForbiddenPath);
          if (forbidden.length > 0) {
            git("reset HEAD", worktree);
            return JSON.stringify({
              success: false,
              error: `Forbidden paths in staged changes: ${forbidden.join(", ")}`,
            });
          }

          git(`commit --author="${botName} <${botName.toLowerCase()}@meai.researcher>" -m "${message.replace(/"/g, '\\"')}"`, worktree);
          git("push -u origin HEAD", worktree, 60000);
          return JSON.stringify({ success: true, message });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── create_pr ────────────────────────────────────────────────
    {
      name: "repo_create_pr",
      description: "Create a GitHub PR. Enforces diff budget (max 10 files, 500 lines) and test pass requirement.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title (under 70 chars)" },
          body: { type: "string", description: "PR description" },
          topicId: { type: "string", description: "Associated topic ID" },
        },
        required: ["title", "body", "topicId"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        enforceWriteMode();

        const title = input.title as string;
        const body = input.body as string;
        const topicId = input.topicId as string;

        // Check diff budget
        const stats = getDiffStats(worktree);
        if (stats.files > MAX_FILES) {
          return JSON.stringify({
            success: false,
            error: `Diff budget exceeded: ${stats.files} files (max ${MAX_FILES}). Split into smaller PRs.`,
          });
        }
        if (stats.totalLines > MAX_LINES) {
          return JSON.stringify({
            success: false,
            error: `Diff budget exceeded: ${stats.totalLines} lines (max ${MAX_LINES}). Split into smaller PRs.`,
          });
        }

        // Check open PR limit
        const { data } = readAgenda();
        const myOpenPRs = data.topics.filter(
          t => t.owner === botName && ["pr_open", "under_review"].includes(t.status)
        );
        if (myOpenPRs.length >= 1) {
          return JSON.stringify({
            success: false,
            error: `Already have open PR for ${myOpenPRs[0].id}. Complete it first.`,
          });
        }

        try {
          const prBody = `${body}\n\n---\nTopic: ${topicId}\nAgent: ${botName}\nLabel: agent-generated`;
          const result = execSync(
            `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --label agent-generated`,
            { cwd: worktree, encoding: "utf-8", timeout: 30000 },
          ).trim();

          return JSON.stringify({ success: true, prUrl: result, topicId });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── list_open_prs ────────────────────────────────────────────
    {
      name: "repo_list_open_prs",
      description: "List open PRs with the agent-generated label.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: async (): Promise<string> => {
        try {
          const result = execSync(
            'gh pr list --label agent-generated --json number,title,author,url,createdAt --state open',
            { cwd: repoRoot, encoding: "utf-8", timeout: 15000 },
          ).trim();
          return JSON.stringify({ success: true, prs: JSON.parse(result || "[]") });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── read_pr_comments ─────────────────────────────────────────
    {
      name: "repo_read_pr_comments",
      description: "Read review comments on a PR.",
      inputSchema: {
        type: "object",
        properties: {
          prNumber: { type: "number", description: "PR number" },
        },
        required: ["prNumber"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const prNumber = input.prNumber as number;
        try {
          const result = execSync(
            `gh pr view ${prNumber} --json comments,reviews --comments`,
            { cwd: repoRoot, encoding: "utf-8", timeout: 15000 },
          ).trim();
          return JSON.stringify({ success: true, data: JSON.parse(result || "{}") });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    // ── abandon_branch ───────────────────────────────────────────
    {
      name: "repo_abandon_branch",
      description: "Clean up a failed branch and worktree state.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const branch = git("rev-parse --abbrev-ref HEAD", worktree);
          git("checkout main", worktree);
          git(`branch -D "${branch}"`, worktree);
          return JSON.stringify({ success: true, branch, reason: input.reason });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
