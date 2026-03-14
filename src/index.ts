/**
 * MeAI — Entry point.
 *
 * Loads config, creates session manager, tool registry, agent loop,
 * wires up Telegram callbacks for Tier 3/4 approval gates, and starts the bot.
 *
 * Architecture:
 * - Background tasks (emotion, schedule, memory, curiosity, social): Claude Sonnet 4.6
 * - Real-time conversation: Claude CLI (Max subscription)
 * - X (Twitter): autonomous posting + real-time reading
 */

// Disable mem0 telemetry (PostHog) before any imports touch it
process.env.MEM0_TELEMETRY = "false";

// Prepend HH:mm:ss timestamp (PST) to all console output
for (const method of ["log", "warn", "error"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const ts = new Date().toLocaleTimeString("en-US", {
      timeZone: getUserTZ(),
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (typeof args[0] === "string") {
      args[0] = `${ts} ${args[0]}`;
    } else {
      args.unshift(ts);
    }
    original(...args);
  };
}

import { getUserTZ } from "./lib/pst-date.js";
import { loadConfig } from "./config.js";
import { createChannel } from "./channel/factory.js";
import type { Channel } from "./channel/types.js";
import { TelegramChannel } from "./channel/telegram.js";
import { SessionManager } from "./session/manager.js";
import { ToolRegistry } from "./agent/tools.js";
import { AgentLoop } from "./agent/loop.js";
import { setupToolApprovalHandlers } from "./evolution/installer.js";
import { setupPatchApprovalHandlers, restorePendingPatches } from "./evolution/patcher.js";
import { PromptOptimizer } from "./evolution/prompt-optimizer.js";
import { ProactiveScheduler } from "./proactive.js";
import { CuriosityEngine } from "./curiosity.js";
import { XClient } from "./x-client.js";
import { SocialEngine } from "./social.js";
import { initWorld } from "./world.js";
import { initEmotion } from "./emotion.js";
import { initInterests } from "./interests.js";
import { initHobbies } from "./hobbies.js";
import { initFriends } from "./friends.js";
import { initEntertainment } from "./entertainment.js";
import { initBody } from "./body.js";
import { ActivityScheduler } from "./activities.js";
import { Heartbeat } from "./heartbeat.js";
import { WatchdogEngine } from "./watchdog.js";
import { initMem0 } from "./memory/mem0-engine.js";
import { initStoreManager } from "./memory/store-manager.js";
import { initNotifications } from "./notifications.js";
import { initSelfie } from "./selfie.js";
import { initTTS } from "./tts.js";
import { initVideo } from "./video.js";
import { initMusic } from "./music.js";
import { initContextEval } from "./agent/context-eval.js";
import { initSearch } from "./lib/search.js";
import { initGoals } from "./goals.js";
import { initJournal } from "./journal.js";
import { initOpinions } from "./opinions.js";
import { initRelationshipModel } from "./lib/relationship-model.js";
import { initReinforcement } from "./lib/reinforcement.js";
import { initAttention } from "./lib/attention.js";
import { initNarrative } from "./narrative.js";
import { initDocuments } from "./documents.js";
import { initMoments } from "./moments.js";
import { initTimeline } from "./timeline.js";
import { initCharacter } from "./character.js";
import { moduleRegistry } from "./modules/registry.js";
import { llmRegistry } from "./llm/registry.js";
import { expressionRegistry } from "./expressions/registry.js";
import { senseRegistry } from "./senses/registry.js";
import { initPromptTrace } from "./lib/prompt-trace.js";
import { initTurnTrace } from "./lib/turn-trace.js";
import { initActionGate } from "./lib/action-gate.js";
import { initErrorMetrics } from "./lib/error-metrics.js";
import { initBrainstem, startBrainstem, stopBrainstem } from "./brainstem/index.js";
import { initEpisodes } from "./memory/episodes.js";
import { initCareTopics } from "./care-topics.js";
import { initIntents } from "./intents.js";
import { initUserState } from "./user-state.js";
import { initInteractionLearning, recordUserReply, getPendingProactive } from "./interaction-learning.js";
import { initResearch, ResearchEngine } from "./research.js";
import { initSelfNarrative } from "./self-narrative.js";
import { initRelationalImpact } from "./relational-impact.js";
import { initMaxOAuth, isMaxOAuthAvailable } from "./max-oauth.js";
import { researcherRecovery } from "./researcher/recovery.js";
import { initBrainstemBridge } from "./researcher/brainstem-bridge.js";
import { startOmegaMonitor } from "./researcher/omega-monitor.js";
import { startMergeDetector } from "./researcher/merge-detector.js";
import { initClaudeRunnerApi } from "./claude-runner.js";
import { initTurnDirective } from "./agent/turn-directive.js";
import { initReconsolidationProposals } from "./memory/reconsolidation.js";
import { initStateSchema, validateAllStates } from "./lib/state-schema.js";

async function safeInit(name: string, fn: () => unknown | Promise<unknown>, critical = false): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[init] ${critical ? "FATAL" : "WARNING"}: ${name} failed:`, (err as Error).message);
    if (critical) process.exit(1);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("MeAI starting...");

  const config = loadConfig();
  console.log(`Config loaded. State path: ${config.statePath}`);
  const provider = config.conversationProvider === "openai" ? "OpenAI" : "Anthropic API (Max OAuth preferred)";
  console.log(`Conversation: ${provider} (${config.model})`);

  let moduleCount = 0;
  let moduleTotal = 0;

  const track = async (name: string, fn: () => unknown | Promise<unknown>, critical = false) => {
    moduleTotal++;
    if (await safeInit(name, fn, critical)) moduleCount++;
  };

  // Initialize state schema (versioned state files)
  await track("state-schema", () => initStateSchema(config.statePath));

  // Critical modules — crash on failure
  await track("character", () => initCharacter(config.statePath), true);

  // Researcher recovery — runs BEFORE skill loader, releases expired leases,
  // cleans orphan branches, acquires instance lock. Skips if botName not set.
  let researcherPaused = false;
  if (config.botName) {
    const { proceed } = await researcherRecovery(config);
    if (!proceed) {
      researcherPaused = true;
      console.log(`[researcher] ${config.botName} in paused mode — heartbeat only, no actions`);
    }
  }

  // Initialize Max OAuth (token-based auth via Claude Max subscription)
  // Always initialize — Max OAuth is the preferred path for ALL LLM calls ($0 cost)
  await track("max-oauth", () => {
    initMaxOAuth(config.statePath, config.maxOAuthTokenPath);
    if (isMaxOAuthAvailable()) {
      console.log("[max-oauth] Claude Max subscription active — $0 API cost for ALL LLM calls");
      initClaudeRunnerApi(config.anthropicApiKey ?? "");
    } else if (config.anthropicApiKey) {
      console.log("[max-oauth] Token file not found — using Anthropic API key as fallback");
      console.log("[max-oauth] For $0 cost, generate tokens with: npx anthropic-max-router");
      // Initialize claude-runner with API key directly (no OAuth)
      initClaudeRunnerApi(config.anthropicApiKey);
    } else {
      console.log("[max-oauth] No OAuth tokens and no API key — falling back to CLI");
      console.log("[max-oauth] Generate tokens with: npx anthropic-max-router");
    }
  });

  // Initialize prompt trace (JSONL recording of all LLM calls)
  await track("prompt-trace", () => initPromptTrace(config.statePath));

  // Initialize turn trace (unified per-turn observability)
  await track("turn-trace", () => initTurnTrace(config.statePath));

  // Initialize action gate (perimeter checks for proactive + social)
  await track("action-gate", () => initActionGate(config.statePath));

  // Initialize error metrics (lightweight error counter)
  await track("error-metrics", () => initErrorMetrics(config.statePath));

  // Initialize shared search module (Tavily + DuckDuckGo fallback)
  await track("search", () => initSearch(config));

  // Initialize world module — market data + LLM-generated daily schedule
  await track("world", () => initWorld({ statePath: config.statePath }));

  // Initialize emotion engine — causal mood generation from real-world signals
  await track("emotion", () => initEmotion({ statePath: config.statePath }));

  // Initialize interests — subscriptions persistence for YouTube + podcasts
  await track("interests", () => initInterests(config.statePath));

  // Initialize hierarchical memory store (split into 5 category files)
  const storeManager = initStoreManager(config.statePath);
  await track("memory-store", () => storeManager.migrateIfNeeded());

  // Initialize mem0 semantic memory engine (OpenAI gpt-4o-mini + text-embedding-3-small)
  const mem0 = await initMem0(config);
  if (mem0) {
    mem0.syncFromStore(storeManager.loadAll()).catch((err) =>
      console.error("[mem0] Background sync error:", err),
    );
  }

  // Initialize life simulation modules — hobbies, friends, entertainment, body
  await track("hobbies", () => initHobbies(config.statePath));
  await track("friends", () => initFriends(config.statePath));
  await track("entertainment", () => initEntertainment(config.statePath));
  await track("body", () => initBody(config.statePath));
  await track("notifications", () => initNotifications(config.statePath));
  await track("selfie", () => initSelfie(config));
  await track("tts", () => initTTS(config));
  await track("video", () => initVideo(config));
  await track("music", () => initMusic(config));
  await track("context-eval", () => initContextEval(config.statePath));
  await track("goals", () => initGoals(config.statePath));
  await track("journal", () => initJournal(config.statePath));
  await track("opinions", () => initOpinions(config.statePath));
  await track("relationship-model", () => initRelationshipModel(config.statePath));
  await track("reinforcement", () => initReinforcement(config.statePath));
  await track("attention", () => initAttention(config.statePath));
  await track("narrative", () => initNarrative(config.statePath));
  await track("documents", () => initDocuments(config.statePath));
  await track("timeline", () => initTimeline(config.statePath));
  await track("intents", () => initIntents(config.statePath));
  await track("care-topics", () => initCareTopics(config.statePath));
  await track("user-state", () => initUserState(config.statePath));
  await track("episodes", () => initEpisodes(config.statePath));
  await track("interaction-learning", () => initInteractionLearning(config.statePath));
  await track("self-narrative", () => initSelfNarrative(config.statePath));
  await track("relational-impact", () => initRelationalImpact(config.statePath));
  await track("research", () => initResearch(config.statePath));
  await track("turn-directive", () => initTurnDirective(config.statePath));
  await track("reconsolidation", () => initReconsolidationProposals(config.statePath));

  // Brainstem event bridge — connects research workflow to brainstem signals
  if (config.botName && config.enableResearcherDriveBridge) {
    await track("brainstem-bridge", () => initBrainstemBridge(config));
  }

  // Discover and initialize extensible registries (all 5 axes)
  await Promise.all([
    safeInit("module-registry", () => moduleRegistry.discover()),
    safeInit("llm-registry", () => llmRegistry.discover()),
    safeInit("expression-registry", () => expressionRegistry.discover()),
    safeInit("sense-registry", () => senseRegistry.discover()),
  ]);

  // Configure LLM role mapping from config
  if (config.llm) {
    llmRegistry.setRoleMapping(config.llm);
  }

  await Promise.all([
    safeInit("modules", () => moduleRegistry.initAll(config)),
    safeInit("llm-providers", () => llmRegistry.initAll(config)),
    safeInit("expressions", () => expressionRegistry.initAll(config)),
    safeInit("senses", () => senseRegistry.initAll(config)),
  ]);

  // Initialize brainstem — continuous neural thinking layer (optional)
  await track("brainstem", () => {
    initBrainstem(config);
    startBrainstem();
    console.log("[brainstem] Continuous neural thinking initialized");
  });

  // Validate all registered state schemas (log warnings, no crash)
  validateAllStates();

  const session = new SessionManager(config);
  const tools = new ToolRegistry();
  const channel = createChannel(config);

  // Initialize moments — posts life moments to a channel
  // For Telegram, we still need the underlying bot for moments + approval handlers
  const telegramBot = channel instanceof TelegramChannel ? channel.getBot() : null;
  await track("moments", () => initMoments(config, telegramBot));

  // Wire up channel callbacks for tool approval gates
  tools.setCallbacks({
    sendToolProposal: (name, description, code) =>
      channel.sendToolProposal?.(name, description, code) ?? Promise.resolve(),
    sendPatchProposal: (patchId, reason, filesChanged) =>
      channel.sendPatchProposal?.(patchId, reason, filesChanged) ?? Promise.resolve(),
    sendMessage: async (text) => {
      await channel.sendMessage(text);
    },
    sendPhoto: async (photo, caption) => {
      await channel.sendPhoto(photo, caption);
    },
  });

  // Set up inline keyboard handlers for Tier 3 tool approval and Tier 4 patch approval
  // (Telegram-specific — other channels implement approval differently)
  if (telegramBot) {
    setupToolApprovalHandlers(telegramBot, config);
    const sendMsg = async (text: string) => { await channel.sendMessage(text); };
    setupPatchApprovalHandlers(telegramBot, config, sendMsg);
    restorePendingPatches(config, sendMsg);
  }

  // Curiosity engine — the character explores the web and learns autonomously
  let curiosity!: CuriosityEngine;
  await track("curiosity", () => { curiosity = new CuriosityEngine(config); });

  // X (Twitter) integration — autonomous posting + real-time reading
  let social: SocialEngine | null = null;
  if (config.xApiKey && config.xApiKeySecret && config.xAccessToken && config.xAccessTokenSecret) {
    const xClient = new XClient({
      apiKey: config.xApiKey,
      apiKeySecret: config.xApiKeySecret,
      accessToken: config.xAccessToken,
      accessTokenSecret: config.xAccessTokenSecret,
    });
    social = new SocialEngine(config, xClient, curiosity);

    // Give curiosity engine access to X for real-time info
    curiosity.setXClient(xClient);

    console.log("[x] X (Twitter) integration enabled");
  } else {
    console.log("[x] X credentials not configured — social features disabled");
  }

  const agent = new AgentLoop(config, session, tools, curiosity);
  agent.setSendPhoto(async (photo, caption) => {
    await channel.sendPhoto(photo, caption);
  });
  agent.setSendVoice(async (audio, caption) => {
    await channel.sendVoice?.(audio, caption);
  });
  agent.setSendVideo(async (video, caption) => {
    await channel.sendVideo?.(video, caption);
  });
  agent.setSendAudio(async (audio, title, performer) => {
    await channel.sendAudio?.(audio, title, performer);
  });
  agent.setDeleteMessage(async (messageId) => {
    await channel.deleteMessage?.(messageId);
  });

  // Proactive messaging — character will reach out to user on their own
  const proactive = new ProactiveScheduler(config, session, async (text) => {
    await channel.sendMessage(text);
  }, curiosity);
  proactive.setSendPhoto(async (photo, caption) => {
    await channel.sendPhoto(photo, caption);
  });
  proactive.setSendVideo(async (video, caption) => {
    await channel.sendVideo?.(video, caption);
  });
  proactive.setSendVoice(async (audio, caption) => {
    await channel.sendVoice?.(audio, caption);
  });

  channel.onMessage(async (text, chatId, sendReply, editReply, sendTyping, imageData) => {
    proactive.recordUserActivity();

    // Interaction learning: detect reply to proactive message
    const pending = getPendingProactive();
    if (pending.pending && pending.sentAt) {
      const delayMs = Date.now() - pending.sentAt;
      recordUserReply(text.length, delayMs);
    }

    await agent.handleMessage(text, chatId, sendReply, editReply, sendTyping, imageData);
  });

  channel.onTranscribe?.(async (buffer, filename) => {
    return agent.transcribeAudio(buffer, filename);
  });

  // Activity scheduler — the character does vibe coding, deep reading, learning on their own
  const activities = new ActivityScheduler(config);
  proactive.setActivities(activities);

  // Initialize X user identity (needed for social.tick())
  if (social) {
    await social.init().catch((err) => console.error("[social] X init error:", err));
  }

  // Immune system — health monitoring, circuit breaker, guardrails
  const watchdog = new WatchdogEngine(config);
  watchdog.setAlertFn(async (text) => {
    await channel.sendMessage(text);
  });

  // LLM Heartbeat — the character's pulse, coordinates all background modules
  // Replaces individual module self-scheduling loops.
  // Every ~5 min: LLM evaluates holistic state → decides what to do.
  const heartbeat = new Heartbeat(config, {
    curiosity,
    proactive,
    social,
    activities,
  });
  // Research engine — autonomous research system
  try {
    const research = new ResearchEngine(config);
    heartbeat.setResearch(research);
    console.log("[research] Autonomous research engine initialized");
  } catch { /* research is optional */ }

  heartbeat.setWatchdog(watchdog);
  watchdog.setHeartbeat(heartbeat);
  heartbeat.start();
  watchdog.start();

  // Researcher monitors — only for researcher bots
  if (config.botName) {
    startOmegaMonitor(config, channel);  // Only active for Omega
    startMergeDetector(config.botName, process.cwd()); // Only active for researchers
  }

  const optimizer = new PromptOptimizer(config);
  optimizer.start();

  // ── MAIP Protocol Bridge (optional) ────────────────────────────────
  if (config.maip?.enabled) {
    try {
      const { initMAIP, recordHeartbeatAction } = await import("./maip/bridge.js");
      const maipBridge = await initMAIP(config);
      if (maipBridge) {
        // Hook heartbeat → MAIP homecoming reports
        heartbeat.setOnPulse(recordHeartbeatAction);

        // Register MAIP channel handler — MAIP peers route through the same agent loop
        const maipChannel = maipBridge.getChannel();
        if (maipChannel) {
          maipChannel.onMessage(async (text, chatId, sendReply, editReply, sendTyping) => {
            await agent.handleMessage(text, chatId, sendReply, editReply, sendTyping);
          });
        } else {
          console.warn("[maip] Bridge started but getChannel() returned null");
        }

        console.log(`[maip] Bridge started — DID: ${maipBridge.getDid()}`);
      }
    } catch (err) {
      console.error("[maip] Failed to initialize:", (err as Error).message);
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────
  const shutdown = async () => {
    console.log("[shutdown] Stopping...");
    heartbeat.stop();
    watchdog.stop();
    proactive.stop();
    curiosity.stop();
    social?.stop();
    activities.stop();
    optimizer.stop();
    try { stopBrainstem(); } catch { /* brainstem may not be initialized */ }
    if (config.maip?.enabled) {
      try {
        const { stopMAIP } = await import("./maip/bridge.js");
        await stopMAIP();
      } catch { /* non-fatal */ }
    }
    await channel.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGUSR1", shutdown);

  console.log(`[init] MeAI ready — ${moduleCount}/${moduleTotal} modules active`);

  await channel.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
