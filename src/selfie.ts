/**
 * Visual identity — gives the character a face.
 *
 * Three layers:
 * 1. Sticker pack: pre-generated emoji-style stickers (batch via scripts/)
 * 2. Contextual selfies: FLUX Kontext generates scene-aware photos on demand
 * 3. (Future) LoRA fine-tuning for consistent identity
 *
 * Requires:
 * - data/selfie/reference.png — hand-placed reference photo
 * - config.falApiKey — fal.ai API key
 *
 * If either is missing, the entire visual system is disabled (graceful degradation).
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { claudeText } from "./claude-runner.js";
import { createLogger } from "./lib/logger.js";
import { getWorkContext, getOutfit, fetchWeather } from "./world.js";
import { getCharacter, s } from "./character.js";
import { getEmotionalState } from "./emotion.js";
import { onSelfieGenerated } from "./moments.js";
import type { AppConfig } from "./types.js";

const log = createLogger("selfie");

// ── Types ────────────────────────────────────────────────────────────

export type SelfieTrigger =
  | "what_doing"
  | "outfit"
  | "show_me"
  | "cat"
  | "proactive_share"
  | "proactive_morning"
  | "proactive_emotion"
  | "proactive_random"
  | "manual";

interface SelfieRecord {
  timestamp: number;
  trigger: string;
  prompt: string;
  imagePath: string;
}

interface SelfieState {
  stickerSetName: string | null;
  stickerMap: Record<string, string>; // emotion id -> sticker file_id
  recentSelfies: SelfieRecord[];
  dailyDate: string;
  dailyCount: number;
  lastSelfieAt: number;
  loraUrl?: string;           // Trained LoRA weights URL
  loraTriggerPhrase?: string; // Trigger phrase for LoRA activation
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

const MAX_DAILY_SELFIES = 15;
const MIN_SELFIE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_STORED_IMAGES = 100;

// ── SelfieEngine class ──────────────────────────────────────────────

export class SelfieEngine {
  private config: AppConfig;
  private referencePath: string;
  private statePath: string;
  private generatedDir: string;
  private referenceBase64: string | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.referencePath = path.join(config.statePath, "selfie", "reference.png");
    this.statePath = path.join(config.statePath, "selfie", "selfie-state.json");
    this.generatedDir = path.join(config.statePath, "selfie", "generated");

    if (!this.isVisualIdentityEnabled()) {
      log.info("Visual identity disabled (missing falApiKey or reference.png)");
      return;
    }

    // Pre-load reference image
    try {
      this.referenceBase64 = fs.readFileSync(this.referencePath).toString("base64");
      log.info("Visual identity enabled — reference image loaded");
    } catch {
      log.warn("Failed to read reference.png");
      this.referenceBase64 = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  isVisualIdentityEnabled(): boolean {
    if (!this.config?.falApiKey) return false;
    // LoRA mode: only needs falApiKey + trained LoRA
    const state = this.loadState();
    if (state.loraUrl) return true;
    // Fallback Kontext mode: needs reference image
    if (!fs.existsSync(this.referencePath)) return false;
    return true;
  }

  /**
   * Generate a contextual selfie.
   * Returns the image buffer and a caption, or null if rate-limited / disabled.
   */
  async generateSelfie(
    trigger: SelfieTrigger,
    conversationContext?: string,
  ): Promise<{ image: Buffer; caption: string; imagePath: string } | null> {
    if (!this.isVisualIdentityEnabled() || !this.config || !this.referenceBase64) return null;

    // Rate limiting
    const state = this.loadState();
    const now = Date.now();
    const todayStr = pstDateStr();

    // Reset daily counter
    if (state.dailyDate !== todayStr) {
      state.dailyDate = todayStr;
      state.dailyCount = 0;
    }

    if (state.dailyCount >= MAX_DAILY_SELFIES) {
      log.info("Daily selfie limit reached");
      return null;
    }

    if (now - state.lastSelfieAt < MIN_SELFIE_INTERVAL_MS) {
      log.info("Selfie interval too short, skipping");
      return null;
    }

    try {
      // Generate image prompt from context
      const prompt = await this.generateSelfiePrompt(trigger, conversationContext);
      if (!prompt) {
        log.warn("Failed to generate selfie prompt");
        return null;
      }

      log.info(`Generating selfie: trigger=${trigger}, prompt="${prompt.slice(0, 80)}..."`);

      // Generate with quality check retry loop
      let imageBuffer: Buffer | null = null;
      let attempts = 0;

      while (attempts < MAX_RETRIES) {
        attempts++;

        // Call fal.ai FLUX
        const imageUrl = await this.callFalApi(prompt);
        if (!imageUrl) return null;

        // Download the image
        const downloaded = await this.downloadImage(imageUrl);
        if (!downloaded) return null;

        // Quality check via Claude vision
        const quality = await this.checkImageQuality(downloaded);
        if (quality.pass) {
          imageBuffer = downloaded;
          break;
        }

        log.warn(`Quality check failed (attempt ${attempts}/${MAX_RETRIES}): ${quality.reason}`);
        if (attempts < MAX_RETRIES) {
          log.info("Regenerating...");
        }
      }

      if (!imageBuffer) {
        log.error(`All ${MAX_RETRIES} attempts failed quality check`);
        return null;
      }

      // Save to disk
      const filename = `${now}-${trigger}.png`;
      const imagePath = path.join(this.generatedDir, filename);
      fs.writeFileSync(imagePath, imageBuffer);

      // Generate caption
      const caption = this.generateCaption(trigger);

      // Update state
      state.recentSelfies.push({ timestamp: now, trigger, prompt, imagePath });
      state.dailyCount++;
      state.lastSelfieAt = now;

      // Cleanup old images
      this.cleanupOldImages(state);

      this.saveState(state);

      log.info(`Selfie generated: ${filename} (${attempts} attempt${attempts > 1 ? "s" : ""})`);

      // Post to moments channel
      onSelfieGenerated(imagePath, trigger).catch(() => { /* non-fatal */ });

      return { image: imageBuffer, caption, imagePath };
    } catch (err) {
      log.error("Selfie generation failed", err);
      return null;
    }
  }

  /**
   * Detect selfie triggers from user message text.
   */
  detectSelfieTrigger(text: string): SelfieTrigger | null {
    if (!this.isVisualIdentityEnabled()) return null;

    const patterns: Array<{ pattern: RegExp; trigger: SelfieTrigger }> = [
      { pattern: new RegExp(s().patterns.selfie_what_doing.join("|"), "i"), trigger: "what_doing" },
      { pattern: new RegExp(s().patterns.selfie_outfit.join("|"), "i"), trigger: "outfit" },
      { pattern: new RegExp(s().patterns.selfie_show_me.join("|"), "i"), trigger: "show_me" },
      { pattern: new RegExp(s().patterns.selfie_pet.join("|"), "i"), trigger: "cat" },
    ];

    for (const { pattern, trigger } of patterns) {
      if (pattern.test(text)) return trigger;
    }

    return null;
  }

  /**
   * Select a sticker based on emotional state.
   * Returns file_id or null if no sticker pack is configured.
   */
  selectSticker(emotion: {
    valence: number;
    energy: number;
  }): string | null {
    const state = this.loadState();
    if (!state.stickerSetName || Object.keys(state.stickerMap).length === 0) {
      return null;
    }

    // Map emotion to sticker category
    const { valence, energy } = emotion;
    let stickerId: string;

    if (valence > 0.6 && energy > 0.6) stickerId = "excited";
    else if (valence > 0.5 && energy > 0.3) stickerId = "happy";
    else if (valence > 0.3 && energy < 0.3) stickerId = "goodnight";
    else if (valence < -0.3 && energy > 0.5) stickerId = "angry";
    else if (valence < -0.3 && energy < 0.3) stickerId = "tired";
    else if (valence < -0.1) stickerId = "annoyed";
    else if (energy < 0.3) stickerId = "thinking";
    else stickerId = "ok";

    return state.stickerMap[stickerId] ?? null;
  }

  /**
   * Whether to spontaneously send a sticker with the response.
   * ~10% probability.
   */
  shouldSendSticker(): boolean {
    if (!this.isVisualIdentityEnabled()) return false;
    const state = this.loadState();
    if (!state.stickerSetName) return false;
    return Math.random() < 0.10;
  }

  /**
   * 9.1: Context-aware sticker timing — send stickers at emotional beats, not randomly.
   * Detects emotional peaks in response text and adjusts probability accordingly.
   */
  shouldSendStickerAfterText(
    responseText: string,
    emotion: { valence: number; energy: number },
  ): boolean {
    if (!this.isVisualIdentityEnabled()) return false;
    const state = this.loadState();
    if (!state.stickerSetName || Object.keys(state.stickerMap).length === 0) return false;

    const hasEmotionalPeak = new RegExp(s().patterns.emotional_peak.join("|"), "i").test(responseText);
    const isExtremeValence = emotion.valence <= 2 || emotion.valence >= 9;
    const isHighEnergy = emotion.energy >= 8;

    // Emotional peak + high energy/extreme valence → 40%
    if (hasEmotionalPeak && (isHighEnergy || isExtremeValence)) return Math.random() < 0.40;
    // Peak only → 20%
    if (hasEmotionalPeak) return Math.random() < 0.20;
    // Extreme valence only → 10%
    if (isExtremeValence) return Math.random() < 0.10;
    // Baseline → 2%
    return Math.random() < 0.02;
  }

  /**
   * 9.2: Check if a selfie with this emotional context was already sent recently.
   * Prevents redundant selfies within a 4-hour window.
   */
  isRedundantSelfie(trigger: SelfieTrigger, emotionalContext: string): boolean {
    const state = this.loadState();
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const recentContexts = (state as SelfieState & { recentContexts?: RecentSelfieContext[] }).recentContexts ?? [];

    return recentContexts.some(ctx =>
      ctx.timestamp > fourHoursAgo && ctx.emotionalContext === emotionalContext,
    );
  }

  /**
   * 9.2: Record the context of a selfie generation for pacing.
   */
  recordSelfieContext(trigger: SelfieTrigger, emotionalContext: string): void {
    const state = this.loadState() as SelfieState & { recentContexts?: RecentSelfieContext[] };
    if (!state.recentContexts) state.recentContexts = [];
    state.recentContexts.push({ timestamp: Date.now(), trigger, emotionalContext });
    // Keep last 10 entries
    if (state.recentContexts.length > 10) state.recentContexts = state.recentContexts.slice(-10);
    this.saveState(state as SelfieState);
  }

  /** How many selfies have been sent today. */
  getSelfieDailyCount(): number {
    const state = this.loadState();
    const todayStr = pstDateStr();
    return state.dailyDate === todayStr ? state.dailyCount : 0;
  }

  /**
   * Maybe take a proactive selfie based on current emotional/activity context.
   * Instead of hardcoded scenarios, asks the LLM to evaluate whether this is
   * a selfie-worthy moment and describe the scene dynamically.
   *
   * @param context — current state: emotion, activity, time, etc.
   */
  async maybeProactiveSelfie(context: {
    mood?: string;
    microEvent?: string;
    activity?: string;
    location?: string;
    timeOfDay?: string;
    hour?: number;
  }): Promise<boolean> {
    if (!this.isVisualIdentityEnabled()) return false;

    // Cooldown: no proactive selfie if one was taken in the last 3 hours
    const state = this.loadState();
    const lastProactive = [...state.recentSelfies]
      .reverse()
      .find(s => s.trigger.startsWith("proactive_"));
    if (lastProactive && Date.now() - lastProactive.timestamp < PROACTIVE_SELFIE_COOLDOWN_MS) {
      return false;
    }

    // Skip deep night (0-7am)
    const hour = context.hour ?? new Date(
      new Date().toLocaleString("en-US", { timeZone: getUserTZ() }),
    ).getHours();
    if (hour >= 0 && hour < 7) return false;

    // Ask LLM: is this a selfie-worthy moment?
    const contextLines = [
      context.timeOfDay ? `Time: ${context.timeOfDay} (${hour}:00)` : "",
      context.activity ? `Doing: ${context.activity}` : "",
      context.location ? `Location: ${context.location}` : "",
      context.mood ? `Mood: ${context.mood}` : "",
      context.microEvent ? `Just happened: ${context.microEvent}` : "",
    ].filter(Boolean).join("\n");

    if (!contextLines) return false;

    try {
      const selfieDecisionPrompt = getCharacter().persona.selfie_decision;
      if (!selfieDecisionPrompt) return false; // skip if no prompt configured
      const result = await claudeText({
        system: selfieDecisionPrompt,
        prompt: contextLines,
        model: "fast",
        timeoutMs: 30_000,
      });

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return false;

      const parsed = JSON.parse(jsonMatch[0]) as {
        take: boolean;
        scene?: string;
        trigger?: string;
      };

      if (!parsed.take || !parsed.scene) return false;

      const trigger = (
        ["proactive_morning", "proactive_share", "proactive_emotion", "proactive_random"]
          .includes(parsed.trigger ?? "")
          ? parsed.trigger
          : "proactive_share"
      ) as SelfieTrigger;

      log.info(`Proactive selfie: ${trigger} — "${parsed.scene.slice(0, 50)}..."`);
      const selfie = await this.generateSelfie(trigger, parsed.scene);
      return selfie !== null;
    } catch (err) {
      log.warn("Proactive selfie evaluation failed", err);
      return false;
    }
  }

  // ── Internal helpers (exposed for sticker script) ──────────────────

  callFalApi(prompt: string): Promise<string | null> {
    return callFalApiImpl(this.config, this.referenceBase64, this.loadState.bind(this), prompt);
  }

  loadState(): SelfieState {
    const defaults: SelfieState = {
      stickerSetName: null,
      stickerMap: {},
      recentSelfies: [],
      dailyDate: "",
      dailyCount: 0,
      lastSelfieAt: 0,
    };
    const loaded = readJsonSafe<SelfieState>(this.statePath, defaults);
    // Backfill fields added after initial schema
    if (!loaded.recentSelfies) loaded.recentSelfies = defaults.recentSelfies;
    if (!loaded.stickerMap) loaded.stickerMap = defaults.stickerMap;
    if (loaded.dailyCount == null) loaded.dailyCount = defaults.dailyCount;
    if (loaded.lastSelfieAt == null) loaded.lastSelfieAt = defaults.lastSelfieAt;
    if (!loaded.dailyDate) loaded.dailyDate = defaults.dailyDate;
    return loaded;
  }

  saveState(state: SelfieState): void {
    writeJsonAtomic(this.statePath, state);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async generateSelfiePrompt(trigger: SelfieTrigger, conversationContext?: string): Promise<string | null> {
    if (!this.config) return null;

    // Gather context in parallel
    const [work, outfit, weather, emotionalState] = await Promise.all([
      getWorkContext(),
      getOutfit(),
      fetchWeather(),
      getEmotionalState(undefined, undefined),
    ]);

    const contextParts: string[] = [];

    // Conversation context is the most important — it captures the specific scene to depict
    if (conversationContext) {
      contextParts.unshift(`⭐ SCENE TO DEPICT (this is the most important input — the photo must show this): ${conversationContext}`);
    }
    if (work.currentActivity) {
      contextParts.push(`Current activity: ${work.currentActivity}`);
    }
    if (work.currentBlock?.details) {
      contextParts.push(`Scene details: ${work.currentBlock.details}`);
    }
    if (work.location) {
      contextParts.push(`Location: ${work.location}`);
    }
    if (outfit) {
      contextParts.push(`Today's outfit: ${outfit}`);
    }
    if (weather) {
      contextParts.push(`Weather: ${weather.condition}, ${weather.temperature}°C`);
    }
    if (emotionalState?.mood) {
      contextParts.push(`Mood: ${emotionalState.mood}`);
    }
    contextParts.push(`Trigger: ${trigger}`);

    const mode = pickPhotoMode(trigger);
    contextParts.push(`Photo mode: ${mode}`);

    const result = await claudeText({
      system: mode === "selfie" ? SELFIE_SYSTEM : THIRD_PERSON_SYSTEM,
      prompt: `Here is her current context:\n${contextParts.join("\n")}`,
      model: "fast",
      timeoutMs: 90_000,
    });

    const prompt = result.trim();
    if (!prompt || prompt.length < 10) return null;
    return prompt;
  }

  private async checkImageQuality(
    imageBuffer: Buffer,
  ): Promise<{ pass: boolean; reason?: string }> {
    if (!this.config?.anthropicApiKey) {
      // No API key — skip quality check, assume pass
      return { pass: true };
    }

    try {
      const anthropic = new Anthropic({ apiKey: this.config.anthropicApiKey });
      const base64 = imageBuffer.toString("base64");

      // Detect actual image format from magic bytes
      const isJpeg = imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8;
      const mediaType = isJpeg ? "image/jpeg" : "image/png";

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: `Check this AI-generated photo of a woman for quality issues.

FAIL if ANY of these:
- Distorted/deformed face or body
- Extra fingers, merged/missing hands
- Two or more people when there should be one
- Mostly black/blank image
- Blurry or garbled beyond recognition

PASS if the image shows one woman without major defects. Clean lighting and polished look is fine.

Reply with EXACTLY one line:
PASS
or
FAIL: <brief reason>`,
              },
            ],
          },
        ],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text.trim() : "";

      if (text.startsWith("PASS")) {
        log.info("Quality check: PASS");
        return { pass: true };
      }

      const reason = text.replace(/^FAIL:\s*/, "").slice(0, 100);
      log.info(`Quality check: FAIL — ${reason}`);
      return { pass: false, reason };
    } catch (err) {
      // Quality check failure shouldn't block generation
      log.warn("Quality check error, assuming pass", err);
      return { pass: true };
    }
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      log.error("Image download failed", err);
      return null;
    }
  }

  private generateCaption(trigger: SelfieTrigger): string {
    const petName = getCharacter().pet?.name ?? "kitty";
    const captions: Record<SelfieTrigger, string[]> = {
      what_doing: ["here~", "look", "here!", ""],
      outfit: ["today's", "outfit!", ""],
      show_me: ["here you go~", "here!", ""],
      cat: [`${petName}~`, "look!", ""],
      proactive_share: ["", "hey~"],
      proactive_morning: ["morning~", ""],
      proactive_emotion: ["", ""],
      proactive_random: ["", "hey"],
      manual: [""],
    };

    const options = captions[trigger] ?? [""];
    return options[Math.floor(Math.random() * options.length)];
  }

  private cleanupOldImages(state: SelfieState): void {
    if (state.recentSelfies.length <= MAX_STORED_IMAGES) return;

    // Remove oldest entries
    const toRemove = state.recentSelfies.splice(
      0,
      state.recentSelfies.length - MAX_STORED_IMAGES,
    );

    for (const record of toRemove) {
      try {
        if (fs.existsSync(record.imagePath)) {
          fs.unlinkSync(record.imagePath);
        }
      } catch { /* ignore cleanup errors */ }
    }
  }
}

// ── Module state (backward compat singleton) ─────────────────────────

let _singleton: SelfieEngine | null = null;

// ── Init ─────────────────────────────────────────────────────────────

export function initSelfie(cfg: AppConfig): SelfieEngine {
  _singleton = new SelfieEngine(cfg);
  return _singleton;
}

// ── Backward-compat function exports ─────────────────────────────────

export function isVisualIdentityEnabled(): boolean {
  return _singleton?.isVisualIdentityEnabled() ?? false;
}

export async function generateSelfie(
  trigger: SelfieTrigger,
  conversationContext?: string,
): Promise<{ image: Buffer; caption: string; imagePath: string } | null> {
  return _singleton?.generateSelfie(trigger, conversationContext) ?? null;
}

export function detectSelfieTrigger(text: string): SelfieTrigger | null {
  return _singleton?.detectSelfieTrigger(text) ?? null;
}

export function selectSticker(emotion: {
  valence: number;
  energy: number;
}): string | null {
  return _singleton?.selectSticker(emotion) ?? null;
}

export function shouldSendSticker(): boolean {
  return _singleton?.shouldSendSticker() ?? false;
}

export function shouldSendStickerAfterText(
  responseText: string,
  emotion: { valence: number; energy: number },
): boolean {
  return _singleton?.shouldSendStickerAfterText(responseText, emotion) ?? false;
}

export function isRedundantSelfie(trigger: SelfieTrigger, emotionalContext: string): boolean {
  return _singleton?.isRedundantSelfie(trigger, emotionalContext) ?? false;
}

export function recordSelfieContext(trigger: SelfieTrigger, emotionalContext: string): void {
  _singleton?.recordSelfieContext(trigger, emotionalContext);
}

export function getSelfieDailyCount(): number {
  return _singleton?.getSelfieDailyCount() ?? 0;
}

export async function maybeProactiveSelfie(context: {
  mood?: string;
  microEvent?: string;
  activity?: string;
  location?: string;
  timeOfDay?: string;
  hour?: number;
}): Promise<boolean> {
  return _singleton?.maybeProactiveSelfie(context) ?? false;
}

interface RecentSelfieContext {
  timestamp: number;
  trigger: string;
  emotionalContext: string;
}

// ── Sticker Templates ────────────────────────────────────────────────

export function getStickerTemplates(): Array<{
  id: string;
  label: string;
  prompt: string;
}> {
  const descriptor = getCharacter().appearance.descriptor;
  return [
    { id: "happy", label: "happy", prompt: `${descriptor}, bright smile, crescent eyes, warm expression, sticker style, white background, cartoon illustration` },
    { id: "tired", label: "tired", prompt: `${descriptor}, sleepy, droopy eyes, yawning, sticker style, white background, cartoon illustration` },
    { id: "excited", label: "excited", prompt: `${descriptor}, very excited, wide eyes, energetic, fist pump, sticker style, white background, cartoon illustration` },
    { id: "annoyed", label: "annoyed", prompt: `${descriptor}, mildly annoyed, slight frown, crossed arms, sticker style, white background, cartoon illustration` },
    { id: "coffee", label: "coffee", prompt: `${descriptor}, holding coffee cup, peaceful morning expression, sticker style, white background, cartoon illustration` },
    { id: "cat_cuddle", label: "cuddling cat", prompt: `${descriptor}, cuddling orange tabby cat, warm smile, sticker style, white background, cartoon illustration` },
    { id: "working", label: "working", prompt: `${descriptor}, focused expression, glasses, looking at laptop, sticker style, white background, cartoon illustration` },
    { id: "thinking", label: "thinking", prompt: `${descriptor}, thoughtful expression, chin on hand, sticker style, white background, cartoon illustration` },
    { id: "eating", label: "eating", prompt: `${descriptor}, happy eating, chopsticks, delicious food, sticker style, white background, cartoon illustration` },
    { id: "goodnight", label: "goodnight", prompt: `${descriptor}, sleepy smile, cozy sweater, waving goodnight, sticker style, white background, cartoon illustration` },
    { id: "surprise", label: "surprised", prompt: `${descriptor}, surprised expression, wide eyes, mouth open, sticker style, white background, cartoon illustration` },
    { id: "cry_laugh", label: "cry-laughing", prompt: `${descriptor}, laughing so hard, tears of joy, sticker style, white background, cartoon illustration` },
    { id: "eyeroll", label: "eye roll", prompt: `${descriptor}, rolling eyes, smirk, sticker style, white background, cartoon illustration` },
    { id: "pout", label: "pouty", prompt: `${descriptor}, pouting, cute expression, puppy eyes, sticker style, white background, cartoon illustration` },
    { id: "angry", label: "angry", prompt: `${descriptor}, angry expression, furrowed brows, steam from head, sticker style, white background, cartoon illustration` },
    { id: "love", label: "heart", prompt: `${descriptor}, making heart shape with hands, sweet smile, sticker style, white background, cartoon illustration` },
    { id: "run", label: "running", prompt: `${descriptor} in athletic wear, jogging pose, energetic, sticker style, white background, cartoon illustration` },
    { id: "pottery", label: "pottery", prompt: `${descriptor}, hands on pottery wheel, clay on fingers, focused, sticker style, white background, cartoon illustration` },
    { id: "cook", label: "cooking", prompt: `${descriptor} in kitchen, cooking with wok, sticker style, white background, cartoon illustration` },
    { id: "ok", label: "OK", prompt: `${descriptor}, OK hand gesture, confident smile, sticker style, white background, cartoon illustration` },
  ];
}

/** @deprecated Use getStickerTemplates() instead — this is kept for backward compat */
export const STICKER_TEMPLATES = getStickerTemplates();

// ── Internal helpers (module-level, not class members) ───────────────

/** Minimum hours between proactive selfies */
const PROACTIVE_SELFIE_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Decide whether this photo should be a selfie or a third-person shot. */
function pickPhotoMode(trigger: SelfieTrigger): "selfie" | "third_person" {
  // Outfit trigger → usually full-body to show the outfit
  if (trigger === "outfit") return Math.random() < 0.8 ? "third_person" : "selfie";
  // Proactive share → mix it up
  if (trigger === "proactive_share" || trigger === "proactive_random") {
    return Math.random() < 0.35 ? "third_person" : "selfie";
  }
  // Everything else → mostly selfie, occasionally third-person
  return Math.random() < 0.2 ? "third_person" : "selfie";
}

const SELFIE_SYSTEM = `Generate a FLUX image prompt for a selfie photo of a young woman based on the context below.

MOST IMPORTANT: The "Conversation context" field describes the SPECIFIC SCENE happening right now. Your prompt MUST reflect this scene — the activity, objects, pets, setting, and mood described. A generic "woman smiling at desk" is WRONG if the context says she's cooking, playing with her cat, or watching a sunset.

Selfie composition:
- Close-up or upper-body framing, shot from arm's length
- Slightly elevated angle (phone held at/above eye level)
- Looking at camera or at the activity (depends on context)
- Slightly off-center, imperfect — like a real phone selfie

Scene must match context:
- If context mentions a cat → cat must be visible in the photo
- If context mentions cooking → kitchen, food, steam visible
- If context mentions sunset → golden light, outdoor setting
- Expression should match the mood described (amused, tired, proud, etc.)
- Background and props should reflect the specific scene, not be generic

Do NOT describe her facial features, hair color, or ethnicity — a LoRA handles identity.
Do NOT use studio lighting or professional photography style.

Format: "Selfie of the woman [scene-specific details], [expression matching mood]. [background with scene elements]. [natural lighting]." — under 50 words.
Style: iPhone selfie, candid, natural.
Output ONLY the prompt text. No explanation, no markdown, no quotes.`;

const THIRD_PERSON_SYSTEM = `Generate a FLUX image prompt for a candid photo of a young woman taken by a friend, based on the context below.

MOST IMPORTANT: The "Conversation context" field describes the SPECIFIC SCENE happening right now. Your prompt MUST reflect this scene — the activity, objects, pets, setting, and mood described. Do NOT generate a generic photo that ignores the context.

Third-person composition:
- Full-body, three-quarter, or upper-body — pick what fits the scene
- Natural angle: eye-level or slightly below, like a friend nearby
- She may be looking at camera, looking away, or engaged in the activity
- Casual composition — a friend snapping a pic, not a photoshoot

Scene must match context:
- If context mentions a cat → cat must be visible
- If context mentions cooking → kitchen setting with food/utensils
- If context mentions an activity → show her doing it
- Expression and pose should match the described mood and situation
- Background must reflect the specific scene described

Do NOT describe her facial features, hair color, or ethnicity — a LoRA handles identity.
Do NOT use studio lighting, editorial style, or fashion poses.

Format: "The woman [scene-specific action/pose], [expression]. [environment with scene elements]. [natural lighting]." — under 50 words.
Style: candid phone photo taken by a friend, natural.
Output ONLY the prompt text. No explanation, no markdown, no quotes.`;

/** Shared fal.ai API implementation used by SelfieEngine.callFalApi */
async function callFalApiImpl(
  cfg: AppConfig | null,
  refBase64: string | null,
  loadStateFn: () => SelfieState,
  prompt: string,
): Promise<string | null> {
  if (!cfg?.falApiKey) return null;

  const state = loadStateFn();
  const hasLora = !!state.loraUrl;

  const loraPrompt = hasLora && state.loraTriggerPhrase
    ? `${state.loraTriggerPhrase} ${prompt}`
    : prompt;

  const payload: Record<string, unknown> = {
    prompt: loraPrompt,
  };

  let endpoint: string;

  if (hasLora) {
    // Text-to-image with trained LoRA — best identity consistency
    endpoint = "https://fal.run/fal-ai/flux-lora";
    payload.loras = [{ path: state.loraUrl, scale: 1.5 }];
    payload.guidance_scale = 3.5;
    payload.num_inference_steps = 28;
    payload.image_size = "square_hd";
    log.info(`Using LoRA t2i: ${state.loraUrl!.slice(-40)}...`);
  } else {
    // Fallback: Kontext Max with reference image
    if (!refBase64) return null;
    endpoint = "https://fal.run/fal-ai/flux-pro/kontext/max";
    payload.image_url = `data:image/png;base64,${refBase64}`;
    payload.guidance_scale = 1.5;
    payload.num_inference_steps = 50;
  }

  const body = JSON.stringify(payload);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Key ${cfg.falApiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      log.error(`fal.ai API error ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as { images?: Array<{ url: string }> };
    return data.images?.[0]?.url ?? null;
  } catch (err) {
    log.error("fal.ai API call failed", err);
    return null;
  }
}

// ── Exports for sticker script (backward compat) ─────────────────────

export function callFalApi(prompt: string): Promise<string | null> {
  return _singleton?.callFalApi(prompt) ?? Promise.resolve(null);
}

export function loadState(): SelfieState {
  if (!_singleton) {
    return {
      stickerSetName: null,
      stickerMap: {},
      recentSelfies: [],
      dailyDate: "",
      dailyCount: 0,
      lastSelfieAt: 0,
    };
  }
  return _singleton.loadState();
}

export function saveState(state: SelfieState): void {
  _singleton?.saveState(state);
}

export type { SelfieState };
