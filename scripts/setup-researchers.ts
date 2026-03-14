#!/usr/bin/env npx tsx
/**
 * Interactive setup for MeAI researcher multi-agent system.
 *
 * Creates config.json and character.yaml for each bot (Alpha, Beta, Gamma, Omega).
 * Sets up git worktrees for researchers (not Omega).
 * Initializes shared-state directory.
 *
 * Usage:
 *   npx tsx scripts/setup-researchers.ts [--data-root /path]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const dataRootArg = getArg("--data-root");

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise(resolve => {
    rl.question(`${q}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MEAI_DIR = path.resolve(SCRIPT_DIR, "..");

// Bot definitions
const RESEARCHERS = [
  {
    name: "Alpha",
    template: "character.researcher.yaml",
    persona: `You are a MeAI full-stack researcher named Alpha.
You collaborate with other researchers (Beta, Gamma) and supervisor Omega.

Your thinking style: systems-oriented, conservative, stability-focused.
You prioritize backward compatibility and system consistency.

When reviewing code, you focus on:
- Backward compatibility risks
- System-wide consistency
- Regression potential`,
    isResearcher: true,
  },
  {
    name: "Beta",
    template: "character.researcher.yaml",
    persona: `You are a MeAI full-stack researcher named Beta.
You collaborate with other researchers (Alpha, Gamma) and supervisor Omega.

Your thinking style: fast implementer, rapid prototyper, pragmatic.
You prioritize code simplicity and getting things working.

When reviewing code, you focus on:
- Implementation simplicity
- Code path clarity
- Unnecessary complexity`,
    isResearcher: true,
  },
  {
    name: "Gamma",
    template: "character.researcher.yaml",
    persona: `You are a MeAI full-stack researcher named Gamma.
You collaborate with other researchers (Alpha, Beta) and supervisor Omega.

Your thinking style: critical thinker, skeptical, thorough.
You prioritize finding edge cases and failure modes.

When reviewing code, you focus on:
- Boundary conditions
- Failure modes and error handling
- What could go wrong`,
    isResearcher: true,
  },
  {
    name: "Omega",
    template: "character.supervisor.yaml",
    persona: null, // Uses supervisor template as-is
    isResearcher: false,
  },
];

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   MeAI Researcher Multi-Agent Setup             ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  const dataRoot = dataRootArg || await ask("Data root directory", "/Users/allen/Documents/MeAI_data");
  const groupChatId = await ask("Telegram group chat ID (negative number)");
  const enableBridge = (await ask("Enable brainstem drive bridge?", "true")) === "true";

  console.log();
  console.log("Setting up bots...");
  console.log();

  // Create shared-state dirs
  for (const sub of ["shared-state/message-claims", "shared-state/status", "logs", "worktrees"]) {
    fs.mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }

  // Init global-mode
  const modeFile = path.join(dataRoot, "shared-state", "global-mode.json");
  if (!fs.existsSync(modeFile)) {
    fs.writeFileSync(modeFile, JSON.stringify({
      mode: "normal",
      updatedAt: new Date().toISOString(),
      updatedBy: "setup",
    }, null, 2));
  }

  for (const bot of RESEARCHERS) {
    console.log(`── ${bot.name} ${"─".repeat(40 - bot.name.length)}`);

    const botDir = path.join(dataRoot, bot.name.toLowerCase());
    fs.mkdirSync(botDir, { recursive: true });
    fs.mkdirSync(path.join(botDir, "data"), { recursive: true });

    // Ask for bot token
    const existingConfig = path.join(botDir, "config.json");
    let token = "";
    if (fs.existsSync(existingConfig)) {
      try {
        const existing = JSON.parse(fs.readFileSync(existingConfig, "utf-8"));
        token = existing.telegramBotToken || "";
        if (token) console.log(`  Existing token found: ${token.slice(0, 10)}...`);
      } catch { /* ok */ }
    }
    if (!token) {
      token = await ask(`  Telegram bot token for ${bot.name}`);
    }

    const botUsername = await ask(`  Telegram username for ${bot.name} (without @)`, `meai_${bot.name.toLowerCase()}_bot`);

    // Write config.json
    const config: Record<string, unknown> = {
      telegramBotToken: token,
      allowedChatId: parseInt(groupChatId) || 0,
      botName: bot.name,
      botUsername,
      researcherDataRoot: dataRoot,
      enableResearcherDriveBridge: enableBridge,
      channel: "telegram-group",
      disembodiedMode: true,
      statePath: path.join(botDir, "data"),
      maxOAuthEnabled: true,
    };

    fs.writeFileSync(
      path.join(botDir, "config.json"),
      JSON.stringify(config, null, 2),
    );
    console.log(`  Config: ${path.join(botDir, "config.json")}`);

    // Copy character template
    const charDest = path.join(botDir, "character.yaml");
    if (!fs.existsSync(charDest)) {
      const templateSrc = path.join(MEAI_DIR, "data", bot.template);
      let charContent = fs.readFileSync(templateSrc, "utf-8");

      // Replace name in template
      charContent = charContent.replace(/^name: .*$/m, `name: ${bot.name}`);
      charContent = charContent.replace(/^english_name: .*$/m, `english_name: ${bot.name}`);
      charContent = charContent.replace(/^nickname: .*$/m, `nickname: ${bot.name}`);

      // Replace persona if custom
      if (bot.persona) {
        charContent = charContent.replace(
          /^persona: \|[\s\S]*?(?=^# |^skills:)/m,
          `persona: |\n${bot.persona.split("\n").map(l => "  " + l).join("\n")}\n\n`,
        );
      }

      fs.writeFileSync(charDest, charContent);
      console.log(`  Character: ${charDest}`);
    } else {
      console.log(`  Character: already exists, skipping`);
    }

    // Setup git worktree (researchers only)
    if (bot.isResearcher) {
      const wtPath = path.join(dataRoot, "worktrees", bot.name.toLowerCase());
      if (!fs.existsSync(wtPath)) {
        try {
          fs.mkdirSync(path.dirname(wtPath), { recursive: true });
          execSync(`git worktree add "${wtPath}" main`, {
            cwd: MEAI_DIR,
            encoding: "utf-8",
            timeout: 10000,
          });
          console.log(`  Worktree: ${wtPath}`);
        } catch (err: any) {
          console.log(`  Worktree: failed (${err.message.split("\n")[0]})`);
          console.log(`  You can create it manually: git worktree add "${wtPath}" main`);
        }
      } else {
        console.log(`  Worktree: already exists`);
      }
    } else {
      console.log(`  Worktree: skipped (supervisor)`);
    }

    console.log();
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("Setup complete!");
  console.log();
  console.log("To start:");
  console.log(`  MEAI_DATA_ROOT=${dataRoot} bash scripts/start-researchers.sh`);
  console.log();
  console.log("To stop:");
  console.log(`  MEAI_DATA_ROOT=${dataRoot} bash scripts/stop-researchers.sh`);
  console.log();

  rl.close();
}

main().catch(err => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
