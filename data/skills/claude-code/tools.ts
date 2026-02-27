/**
 * Claude Code skill for MeAI.
 *
 * Delegates tasks to the `claude` CLI (Claude Code) running as a subprocess.
 * Claude Code can autonomously read/write files, run commands, edit code, and
 * explore directories — it returns the full result back to the MeAI agent.
 *
 * Requirements:
 *   npm install -g @anthropic-ai/claude-code
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

// Maximum output characters to return to the LLM context
const MAX_OUTPUT_CHARS = 8_000;

// Locations to search for the claude binary
const CLAUDE_CANDIDATES = [
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  '/opt/homebrew/bin/claude',
  `${homedir()}/.npm-global/bin/claude`,
  `${homedir()}/.local/bin/claude`,
  `${homedir()}/node_modules/.bin/claude`,
];

// Cache the binary path so we only search once per process lifetime
let _claudePathCache: string | null | undefined = undefined;

/** Find the claude binary. Returns its path, or null if not found. */
async function findClaude(): Promise<string | null> {
  if (_claudePathCache !== undefined) return _claudePathCache;
  for (const p of CLAUDE_CANDIDATES) {
    if (existsSync(p)) { _claudePathCache = p; return p; }
  }
  // Fallback: ask the shell
  return new Promise((res) => {
    const which = spawn('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    which.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    which.on('close', (code: number | null) => {
      const p = out.trim();
      _claudePathCache = (code === 0 && p) ? p : null;
      res(_claudePathCache);
    });
    which.on('error', () => { _claudePathCache = null; res(null); });
  });
}

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'run_claude_code',
      description:
        'Delegate coding tasks and substantial reasoning tasks to Claude Code. ' +
        'Use ONLY for: (1) ANY code task — writing, debugging, refactoring, explaining, reviewing code; ' +
        '(2) reasoning tasks whose answer exceeds ~100 words — analysis, evaluation, ' +
        'research, planning, strategy, math, long-form writing, comparisons, trade-offs. ' +
        'Do NOT use for: time/date queries (use get_current_time), weather, calendar, reminders, ' +
        'web search, casual chat, greetings, memory lookups, yes/no questions, or any task ' +
        'that another loaded skill tool already handles. ' +
        'This tool spawns a subprocess and takes several seconds — only call it when truly needed.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The task to execute. For coding: be specific about language, file paths, requirements. ' +
              'For reasoning: state the question clearly and include any relevant context the user provided. ' +
              'Examples: "Explain the trade-offs between PostgreSQL and MongoDB for a social app with 10M users" ' +
              'or "Write a Python function that parses JSON logs" ' +
              'or "Analyze this architecture and identify potential bottlenecks: [description]".',
          },
          working_dir: {
            type: 'string',
            description:
              'Absolute path to the working directory for the task. ' +
              'Defaults to the home directory if not specified.',
          },
          timeout_seconds: {
            type: 'number',
            description:
              'Maximum seconds to wait before killing the task. Default: 60. ' +
              'Increase for very long tasks like large refactors (max 300).',
          },
          model: {
            type: 'string',
            description:
              'Model to use. "fast" = claude-haiku-4-5-20251001 (default, 3-5x faster, good for most tasks). ' +
              '"smart" = claude-sonnet-4-6 (slower but stronger, use for complex code or deep analysis).',
            enum: ['fast', 'smart'],
          },
        },
        required: ['task'],
      },

      execute: async (args: any): Promise<string> => {
        const { task, working_dir, timeout_seconds = 60 } = args;
        const modelFlag = args.model === 'smart'
          ? 'claude-sonnet-4-6'
          : 'claude-haiku-4-5-20251001';

        // Resolve and validate working directory
        const cwd = working_dir ? resolve(String(working_dir)) : homedir();
        if (!existsSync(cwd)) {
          return JSON.stringify({
            success: false,
            error: `Working directory does not exist: ${cwd}`,
          });
        }

        // Locate the claude binary
        const claudePath = await findClaude();
        if (!claudePath) {
          return JSON.stringify({
            success: false,
            error: 'Claude Code CLI not found.',
            fix: 'Run: npm install -g @anthropic-ai/claude-code',
            searched: CLAUDE_CANDIDATES,
          });
        }

        // Run claude --print <task> non-interactively
        return new Promise((resolve) => {
          let stdout = '';
          let stderr = '';
          let timedOut = false;

          const child = spawn(
            claudePath,
            [
              '--print',                       // Non-interactive mode: print response and exit
              '--dangerously-skip-permissions', // No per-action approval prompts
              '--model', modelFlag,            // Use haiku by default for speed
              task,
            ],
            {
              cwd,
              env: { ...process.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );

          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

          // Enforce timeout
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Give it 3s to clean up before SIGKILL
            setTimeout(() => child.kill('SIGKILL'), 3_000);
          }, timeout_seconds * 1_000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);

            if (timedOut) {
              resolve(JSON.stringify({
                success: false,
                error: `Task timed out after ${timeout_seconds}s`,
                partial_output: stdout.slice(-2_000) || null,
              }));
              return;
            }

            if (code !== 0) {
              resolve(JSON.stringify({
                success: false,
                exit_code: code,
                error: stderr.slice(0, 1_000) || 'Non-zero exit with no stderr',
                partial_output: stdout.slice(0, 2_000) || null,
              }));
              return;
            }

            const truncated = stdout.length > MAX_OUTPUT_CHARS;
            const output = truncated
              ? stdout.slice(0, MAX_OUTPUT_CHARS) + '\n\n[...output truncated to 8000 chars]'
              : stdout;

            resolve(JSON.stringify({
              success: true,
              working_dir: cwd,
              truncated,
              output,
            }));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve(JSON.stringify({
              success: false,
              error: `Failed to spawn claude process: ${err.message}`,
            }));
          });
        });
      },
    },
  ];
}
