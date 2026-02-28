/**
 * MeAIEngine — instantiable engine class for multi-tenant hosting.
 *
 * Wraps all per-user state modules into a single class instance.
 * Self-hosted mode (src/index.ts) creates one instance.
 * meai-cloud creates one per user.
 *
 * Shared/static resources (registries, channels) are NOT owned by the engine.
 */

import type { AppConfig } from "./types.js";
import type { Channel } from "./channel/types.js";
import type { CharacterProfile } from "./character.js";
import { CharacterEngine } from "./character.js";
import { MemoryStoreManager } from "./memory/store-manager.js";
import { Mem0Engine } from "./memory/mem0-engine.js";
import { SessionManager } from "./session/manager.js";
import { EmotionEngine } from "./emotion.js";
import { BodyEngine } from "./body.js";
import { WorldEngine } from "./world.js";
import { TimelineEngine } from "./timeline.js";
import { FriendsEngine } from "./friends.js";
import { HobbiesEngine } from "./hobbies.js";
import { EntertainmentEngine } from "./entertainment.js";
import { GoalsEngine } from "./goals.js";
import { JournalEngine } from "./journal.js";
import { OpinionsEngine } from "./opinions.js";
import { NarrativeEngine } from "./narrative.js";
import { DocumentsEngine } from "./documents.js";
import { InterestsEngine } from "./interests.js";
import { SelfieEngine } from "./selfie.js";
import { TTSEngine } from "./tts.js";
import { VideoEngine } from "./video.js";
import { MusicEngine } from "./music.js";
import { MomentsEngine } from "./moments.js";
import { SearchEngine } from "./lib/search.js";
import { RelationshipEngine } from "./lib/relationship-model.js";
import { AttentionEngine } from "./lib/attention.js";
import { ReinforcementEngine } from "./lib/reinforcement.js";
import { ContextEvalEngine } from "./agent/context-eval.js";
import { NotificationsEngine } from "./notifications.js";
import { ToolRegistry } from "./agent/tools.js";
import { Heartbeat } from "./heartbeat.js";
import { ProactiveScheduler } from "./proactive.js";
import { CuriosityEngine } from "./curiosity.js";
import { SocialEngine } from "./social.js";
import { ActivityScheduler } from "./activities.js";
import { WatchdogEngine } from "./watchdog.js";

// ── Config ──────────────────────────────────────────────────────────

export type EngineConfig = Pick<AppConfig,
  | "statePath"
  | "anthropicApiKey"
  | "allowedChatId"
  | "telegramBotToken"
  | "model"
  | "maxContextTokens"
  | "compactionThreshold"
> & Partial<Omit<AppConfig,
  | "statePath"
  | "anthropicApiKey"
  | "allowedChatId"
  | "telegramBotToken"
  | "model"
  | "maxContextTokens"
  | "compactionThreshold"
>>;

// ── Public types ────────────────────────────────────────────────────

export interface MessageContext {
  chatId: number | string;
  sendReply: (text: string) => Promise<{ messageId: number | string }>;
  editReply: (messageId: number | string, text: string) => Promise<void>;
  sendTyping: () => Promise<void>;
  imageData?: { base64: string; mimeType: string };
}

export interface EngineResponse {
  text: string;
  toolCalls?: Array<{ name: string; input: unknown; output: unknown }>;
}

// ── Engine ──────────────────────────────────────────────────────────

export class MeAIEngine {
  readonly config: AppConfig;

  // Foundation
  readonly character: CharacterEngine;
  readonly storeManager: MemoryStoreManager;
  readonly mem0: Mem0Engine | null;
  readonly session: SessionManager;

  // Core state
  readonly emotion: EmotionEngine;
  readonly body: BodyEngine;
  readonly world: WorldEngine;
  readonly timeline: TimelineEngine;

  // Social / life simulation
  readonly friends: FriendsEngine;
  readonly hobbies: HobbiesEngine;
  readonly entertainment: EntertainmentEngine;
  readonly goals: GoalsEngine;
  readonly journal: JournalEngine;
  readonly opinions: OpinionsEngine;
  readonly narrative: NarrativeEngine;
  readonly documents: DocumentsEngine;
  readonly interests: InterestsEngine;

  // Media
  readonly selfie: SelfieEngine;
  readonly tts: TTSEngine;
  readonly video: VideoEngine;
  readonly music: MusicEngine;
  readonly moments: MomentsEngine;

  // Agent
  readonly tools: ToolRegistry;
  readonly contextEval: ContextEvalEngine;

  // Background engines (already classes — just need singleton call updates)
  readonly heartbeat: Heartbeat;
  readonly proactive: ProactiveScheduler;
  readonly curiosity: CuriosityEngine;
  readonly social: SocialEngine | null;
  readonly activities: ActivityScheduler;
  readonly watchdog: WatchdogEngine;

  // Utilities
  readonly search: SearchEngine;
  readonly relationship: RelationshipEngine;
  readonly notifications: NotificationsEngine;
  readonly attention: AttentionEngine;
  readonly reinforcement: ReinforcementEngine;

  private constructor(
    config: AppConfig,
    modules: {
      character: CharacterEngine;
      storeManager: MemoryStoreManager;
      mem0: Mem0Engine | null;
      session: SessionManager;
      emotion: EmotionEngine;
      body: BodyEngine;
      world: WorldEngine;
      timeline: TimelineEngine;
      friends: FriendsEngine;
      hobbies: HobbiesEngine;
      entertainment: EntertainmentEngine;
      goals: GoalsEngine;
      journal: JournalEngine;
      opinions: OpinionsEngine;
      narrative: NarrativeEngine;
      documents: DocumentsEngine;
      interests: InterestsEngine;
      selfie: SelfieEngine;
      tts: TTSEngine;
      video: VideoEngine;
      music: MusicEngine;
      moments: MomentsEngine;
      tools: ToolRegistry;
      contextEval: ContextEvalEngine;
      heartbeat: Heartbeat;
      proactive: ProactiveScheduler;
      curiosity: CuriosityEngine;
      social: SocialEngine | null;
      activities: ActivityScheduler;
      watchdog: WatchdogEngine;
      search: SearchEngine;
      relationship: RelationshipEngine;
      notifications: NotificationsEngine;
      attention: AttentionEngine;
      reinforcement: ReinforcementEngine;
    },
  ) {
    this.config = config;
    this.character = modules.character;
    this.storeManager = modules.storeManager;
    this.mem0 = modules.mem0;
    this.session = modules.session;
    this.emotion = modules.emotion;
    this.body = modules.body;
    this.world = modules.world;
    this.timeline = modules.timeline;
    this.friends = modules.friends;
    this.hobbies = modules.hobbies;
    this.entertainment = modules.entertainment;
    this.goals = modules.goals;
    this.journal = modules.journal;
    this.opinions = modules.opinions;
    this.narrative = modules.narrative;
    this.documents = modules.documents;
    this.interests = modules.interests;
    this.selfie = modules.selfie;
    this.tts = modules.tts;
    this.video = modules.video;
    this.music = modules.music;
    this.moments = modules.moments;
    this.tools = modules.tools;
    this.contextEval = modules.contextEval;
    this.heartbeat = modules.heartbeat;
    this.proactive = modules.proactive;
    this.curiosity = modules.curiosity;
    this.social = modules.social;
    this.activities = modules.activities;
    this.watchdog = modules.watchdog;
    this.search = modules.search;
    this.relationship = modules.relationship;
    this.notifications = modules.notifications;
    this.attention = modules.attention;
    this.reinforcement = modules.reinforcement;
  }

  /**
   * Create a fully-initialized MeAIEngine.
   * This is the main entry point for both self-hosted and cloud modes.
   */
  static async create(config: EngineConfig): Promise<MeAIEngine> {
    // Fill in defaults for optional AppConfig fields
    const fullConfig: AppConfig = {
      ...config,
    } as AppConfig;

    // Foundation
    const character = new CharacterEngine(fullConfig.statePath);
    character.init();

    const search = new SearchEngine(fullConfig);

    const world = new WorldEngine(fullConfig.statePath);
    const emotion = new EmotionEngine(fullConfig.statePath);
    const interests = new InterestsEngine(fullConfig.statePath);

    const storeManager = new MemoryStoreManager(fullConfig.statePath);
    await storeManager.migrateIfNeeded();

    const mem0 = await Mem0Engine.createFromConfig(fullConfig);
    if (mem0) {
      mem0.syncFromStore(storeManager.loadAll()).catch((err) =>
        console.error("[mem0] Background sync error:", err),
      );
    }

    // Life simulation
    const hobbies = new HobbiesEngine(fullConfig.statePath);
    const friends = new FriendsEngine(fullConfig.statePath);
    const entertainment = new EntertainmentEngine(fullConfig.statePath);
    const body = new BodyEngine(fullConfig.statePath);
    const notifications = new NotificationsEngine(fullConfig.statePath);
    const selfie = new SelfieEngine(fullConfig);
    const tts = new TTSEngine(fullConfig);
    const video = new VideoEngine(fullConfig);
    const music = new MusicEngine(fullConfig);
    const contextEval = new ContextEvalEngine(fullConfig.statePath);
    const goals = new GoalsEngine(fullConfig.statePath);
    const journal = new JournalEngine(fullConfig.statePath);
    const opinions = new OpinionsEngine(fullConfig.statePath);
    const relationship = new RelationshipEngine(fullConfig.statePath);
    const narrative = new NarrativeEngine(fullConfig.statePath);
    const documents = new DocumentsEngine(fullConfig.statePath);
    const timeline = new TimelineEngine(fullConfig.statePath);
    const attention = new AttentionEngine(fullConfig.statePath);
    const reinforcement = new ReinforcementEngine(fullConfig.statePath);

    const session = new SessionManager(fullConfig);
    const tools = new ToolRegistry();

    // Moments needs a bot reference (null for non-Telegram channels)
    const moments = new MomentsEngine(fullConfig, null);

    // Background engines
    const curiosity = new CuriosityEngine(fullConfig);
    const social: SocialEngine | null = null; // Wired externally if X credentials present
    const activities = new ActivityScheduler(fullConfig);

    const proactive = new ProactiveScheduler(fullConfig, session, async () => {}, curiosity);
    const heartbeat = new Heartbeat(fullConfig, {
      curiosity,
      proactive,
      social,
      activities,
    });
    const watchdog = new WatchdogEngine(fullConfig);

    heartbeat.setWatchdog(watchdog);
    watchdog.setHeartbeat(heartbeat);

    return new MeAIEngine(fullConfig, {
      character,
      storeManager,
      mem0,
      session,
      emotion,
      body,
      world,
      timeline,
      friends,
      hobbies,
      entertainment,
      goals,
      journal,
      opinions,
      narrative,
      documents,
      interests,
      selfie,
      tts,
      video,
      music,
      moments,
      tools,
      contextEval,
      heartbeat,
      proactive,
      curiosity,
      social,
      activities,
      watchdog,
      search,
      relationship,
      notifications,
      attention,
      reinforcement,
    });
  }

  /**
   * Start background tasks (heartbeat, watchdog).
   */
  async start(): Promise<void> {
    this.heartbeat.start();
    this.watchdog.start();
  }

  /**
   * Stop all background tasks gracefully.
   */
  async stop(): Promise<void> {
    this.heartbeat.stop();
    this.watchdog.stop();
  }

  // ── State accessors ─────────────────────────────────────────────────

  getCharacter(): CharacterProfile {
    return this.character.getProfile();
  }
}
