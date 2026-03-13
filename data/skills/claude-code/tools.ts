/**
 * Claude Code skill for MeAI.
 *
 * Two modes:
 *   - "code" (default): delegates to the `claude` CLI for filesystem/code tasks
 *   - "reasoning": delegates to the Claude API (via claudeRun) for pure reasoning
 *
 * Requirements for code mode:
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

// Lazy import for claudeRun (reasoning mode)
let _claudeRun: typeof import('../../../src/claude-runner.js').claudeRun | null = null;
async function getClaudeRun() {
  if (!_claudeRun) {
    const mod = await import('../../../src/claude-runner.js');
    _claudeRun = mod.claudeRun;
  }
  return _claudeRun;
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
              'Maximum seconds to wait before killing the task. Default: 180. ' +
              'Increase for very long tasks like large refactors (max 300).',
          },
          model: {
            type: 'string',
            description:
              'Model to use. "fast" = claude-haiku-4-5-20251001 (default, 3-5x faster, good for most tasks). ' +
              '"smart" = claude-sonnet-4-6 (slower but stronger, use for complex code or deep analysis).',
            enum: ['fast', 'smart'],
          },
          mode: {
            type: 'string',
            description:
              'Execution mode. "code" (default) = CLI subprocess for filesystem/code tasks. ' +
              '"reasoning" = API call for pure reasoning without filesystem access.',
            enum: ['code', 'reasoning'],
          },
        },
        required: ['task'],
      },

      execute: async (args: any): Promise<string> => {
        const { task, working_dir, timeout_seconds = 180 } = args;
        const mode = args.mode ?? 'code';
        const modelFlag = args.model === 'smart'
          ? 'claude-sonnet-4-6'
          : 'claude-haiku-4-5-20251001';

        // ── Reasoning mode: API call via claudeRun ──
        if (mode === 'reasoning') {
          try {
            const claudeRun = await getClaudeRun();
            const result = await claudeRun({
              label: 'claude-code.reasoning',
              system: 'You are an expert reasoning assistant. Answer the question thoroughly and accurately.',
              prompt: task,
              model: args.model === 'smart' ? 'smart' : 'fast',
              timeoutMs: timeout_seconds * 1_000,
            });

            if (result && result.trim()) {
              return JSON.stringify({
                success: true,
                mode: 'reasoning',
                verified: true,
                output: result.length > MAX_OUTPUT_CHARS
                  ? result.slice(0, MAX_OUTPUT_CHARS) + '\n\n[...output truncated]'
                  : result,
              });
            }

            return `⚠️ TOOL FAILED: Reasoning returned empty. Do NOT fabricate output — tell the user the tool returned no result.`;
          } catch (err: any) {
            return `⚠️ TOOL FAILED: ${err?.message ?? String(err)}. Do NOT fabricate output — tell the user this error.`;
          }
        }

        // ── Code mode: CLI subprocess ──

        // Resolve and validate working directory
        const cwd = working_dir ? resolve(String(working_dir)) : homedir();
        if (!existsSync(cwd)) {
          return `⚠️ TOOL FAILED: Working directory does not exist: ${cwd}. Do NOT fabricate output — tell the user.`;
        }

        // Locate the claude binary
        const claudePath = await findClaude();
        if (!claudePath) {
          return `⚠️ TOOL FAILED: Claude Code CLI not found. Run: npm install -g @anthropic-ai/claude-code. Do NOT fabricate output — tell the user.`;
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
              resolve(`⚠️ TOOL FAILED: Task timed out after ${timeout_seconds}s. Partial output: ${stdout.slice(-2_000) || '(none)'}. Do NOT fabricate output — tell the user.`);
              return;
            }

            if (code !== 0) {
              resolve(`⚠️ TOOL FAILED: Exit code ${code}. Error: ${stderr.slice(0, 1_000) || 'Non-zero exit with no stderr'}. Partial output: ${stdout.slice(0, 2_000) || '(none)'}. Do NOT fabricate output — tell the user.`);
              return;
            }

            const truncated = stdout.length > MAX_OUTPUT_CHARS;
            const output = truncated
              ? stdout.slice(0, MAX_OUTPUT_CHARS) + '\n\n[...output truncated to 8000 chars]'
              : stdout;

            resolve(JSON.stringify({
              success: true,
              verified: true,
              mode: 'code',
              working_dir: cwd,
              truncated,
              output: `✅ CODE EXECUTED SUCCESSFULLY\n\n${output}`,
            }));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve(`⚠️ TOOL FAILED: Failed to spawn claude process: ${err.message}. Do NOT fabricate output — tell the user.`);
          });
        });
      },
    },
  ];
}
