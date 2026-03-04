/**
 * Character loader — single source of truth for character-specific data.
 *
 * Loads data/character.yaml at startup, validates with Zod, and exports
 * a singleton getter `getCharacter()` for all modules to consume.
 *
 * The YAML file contains structured data that drives code behavior:
 * identity, user info, location, friends, hobbies, body config, persona prompts, etc.
 *
 * The companion narrative document (data/memory/IDENTITY.md) is what
 * the LLM reads as "who am I" — this module provides the structured data.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createLogger } from "./lib/logger.js";
import { claudeText } from "./claude-runner.js";
import type { AppConfig, ToolDefinition } from "./types.js";

const log = createLogger("character");


// ── Zod Schema ───────────────────────────────────────────────────

const FamilyMemberSchema = z.object({
  name: z.string(),
  relation: z.string(),
});

const UserSchema = z.object({
  name: z.string(),
  relationship: z.string().default("friend"),
  location: z.string().optional(),
  work: z.string().optional(),
  family: z.array(FamilyMemberSchema).optional(),
});

const CoordinatesSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

const LocationSchema = z.object({
  city: z.string(),
  city_english: z.string().optional(),
  coordinates: CoordinatesSchema,
  neighborhood: z.string().optional(),
  home: z.string().optional(),
  commute_method: z.string().optional(),
  commute_time: z.string().optional(),
  places: z.record(z.string()).default({}),
});

const WorkSchema = z.object({
  title: z.string(),
  company_type: z.string().optional(),
  sector: z.string().optional(),
  location: z.string().optional(),
  interests: z.array(z.string()).default([]),
});

const PetSchema = z.object({
  name: z.string(),
  type: z.string(),
  breed: z.string().optional(),
  description: z.string().optional(),
});

const FriendSchema = z.object({
  name: z.string(),
  nickname: z.string(),
  relationship: z.string(),
  work: z.string().optional(),
  location: z.string().optional(),
  frequency: z.string().optional(),
  initial_topics: z.array(z.string()).default([]),
  initial_activity: z.string().optional(),
  shared_memories: z.array(z.string()).default([]),
  character_reveals: z.array(z.string()).default([]),
});

const CommunitySchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  members: z.array(z.string()).default([]),
});

const HobbySchema = z.record(z.unknown());

const ExerciseProfileSchema = z.object({
  fatigue_cost: z.number(),
  recovery_hours: z.number(),
  peak_benefit: z.number(),
  mood_boost: z.number(),
});

const BodySchema = z.object({
  menstrual_cycle: z.boolean().default(false),
  cycle_length: z.number().default(28),
  last_period_start: z.string().optional(),
  caffeine_default_hour: z.number().default(7),
  exercise_profiles: z.record(ExerciseProfileSchema).default({}),
  allergy_months: z.array(z.number()).default([]),
  allergy_note: z.string().optional(),
});

const FoodSchema = z.object({
  hometown_cuisine: z.string().optional(),
  workday_lunch: z.array(z.string()).default([]),
  home_cooking: z.object({
    specialties: z.array(z.string()).default([]),
    learning: z.string().optional(),
    lazy_option: z.string().optional(),
    grocery: z.string().optional(),
  }).default({}),
  weekend_restaurants: z.array(z.string()).default([]),
  friend_dining_note: z.string().optional(),
  coffee: z.object({
    daily: z.string().optional(),
    default_drink: z.string().optional(),
  }).default({}),
}).default({});

const AppearanceSchema = z.object({
  ethnicity: z.string().optional(),
  descriptor: z.string().default("woman"),
  hair: z.string().optional(),
  build: z.string().optional(),
  style: z.string().optional(),
  sticker_activities: z.record(z.string()).default({}),
});

const PersonaSchema = z.object({
  compact: z.string().optional(),
  full: z.string().optional(),
  social: z.string().optional(),
  curiosity: z.string().optional(),
  emotion_bio: z.string().optional(),
  life_simulation: z.string().optional(),
  moments: z.string().optional(),
  seasonal_mood: z.record(z.string()).default({}),
  // Large LLM prompt blocks (multi-paragraph templates)
  emotion_behavior: z.string().optional(),
  life_rules: z.string().optional(),
  capabilities: z.string().optional(),
  capabilities_minimal: z.string().optional(),
  schedule_generator: z.string().optional(),
  selfie_decision: z.string().optional(),
  selfie_prompt_gen: z.string().optional(),
  moments_emotion: z.string().optional(),
  moments_selfie: z.string().optional(),
  moments_activity: z.string().optional(),
  moments_discovery: z.string().optional(),
  moments_thought: z.string().optional(),
  knowledge_digest: z.string().optional(),
  timeline_extraction: z.string().optional(),
  // Activity engine prompts
  activity_impulse: z.string().optional(),
  activity_choice: z.string().optional(),
  vibe_coding_idea: z.string().optional(),
  vibe_coding_reflect: z.string().optional(),
  deep_read_reflect: z.string().optional(),
  learn_topic: z.string().optional(),
  learn_instructions: z.string().optional(),
  learn_reflect: z.string().optional(),
  compose_concept: z.string().optional(),
  compose_reflect: z.string().optional(),
  // Proactive outreach
  proactive_outreach: z.string().optional(),
  proactive_context: z.string().optional(),
  // Evolution
  prompt_optimizer: z.string().optional(),
  context_eval_keywords: z.string().optional(),
  // Emotion engine
  emotion_generator: z.string().optional(),
  // Heartbeat
  heartbeat_decision: z.string().optional(),
  // Curiosity engine
  curiosity_query: z.string().optional(),
  curiosity_triage: z.string().optional(),
  curiosity_synthesis: z.string().optional(),
  // Social
  social_post: z.string().optional(),
});

// ── Strings Schema ──────────────────────────────────────────────
// All language-specific strings with English defaults.
// Override in character.yaml to localize.

const HeadersSchema = z.object({
  about_self: z.string().default("About Me"),
  about_user: z.string().default("About {user.name}"),
  user_key_info: z.string().default("Key Info About {user.name}"),
  emotional_memories: z.string().default("Emotional Memories"),
  relevant_knowledge: z.string().default("Relevant Knowledge"),
  recent_insights: z.string().default("Recent Insights"),
  my_memories: z.string().default("What I Remember"),
  no_memories: z.string().default("No memories yet. Use memory_set to save important things during conversations."),
  inner_state: z.string().default("My Current Inner State"),
  recent_moments: z.string().default("My Recent Posts"),
  moments_ownership: z.string().default("These are your own posts — if {user.name} mentions related topics, naturally engage as someone who experienced these things firsthand."),
  my_opinions: z.string().default("My Recent Opinions"),
  opinions_hint: z.string().default("If {user.name} says something you disagree with, don't just go along — push back naturally."),
  my_goals: z.string().default("My Current Goals"),
  capabilities: z.string().default("Internal Capabilities"),
  auto_rules: z.string().default("Auto-optimization Rules"),
  my_diary: z.string().default("My Recent Diary"),
  current_goals: z.string().default("Current Goals"),
  narratives: z.string().default("What's Going On In My Life"),
  my_documents: z.string().default("My Documents"),
  documents_hint: z.string().default("Save documents to {documents_dir}/ with English filenames. After saving, use memory_set to record doc info (title, path, summary) for future reference."),
  real_state: z.string().default("My Current State (time, location, body, life)"),
  my_schedule: z.string().default("My schedule today"),
  my_body: z.string().default("My body state"),
  my_hobbies: z.string().default("My recent hobby progress"),
  my_social: z.string().default("My social life"),
  my_entertainment: z.string().default("What I'm watching/listening to"),
  my_notifications: z.string().default("Phone notifications just received (can mention naturally)"),
  my_discoveries: z.string().default("Things I found online today (can chat about naturally)"),
  my_activities: z.string().default("Things I've been doing recently"),
  today_market: z.string().default("Today's market"),
  pet_moments: z.string().default("What {pet.name} did today"),
  wearing_today: z.string().default("Wearing today"),
  now_doing: z.string().default("Currently doing"),
  now_at: z.string().default("Currently at"),
  people_with: z.string().default("With"),
  next_up: z.string().default("Next up"),
  plan_changes: z.string().default("Plan changes"),
  was_doing: z.string().default("Was just doing: {reason} (just finished, checking phone)"),
  just_happened: z.string().default("Just happened"),
}).default({});

const TimeSchema = z.object({
  day_names: z.array(z.string()).default(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]),
  seasons: z.object({
    spring: z.string().default("spring"),
    summer: z.string().default("summer"),
    fall: z.string().default("fall"),
    winter: z.string().default("winter"),
  }).default({}),
  minutes_ago: z.string().default("{n}min ago"),
  hours_ago: z.string().default("{n}h ago"),
  days_ago: z.string().default("{n} days ago"),
  yesterday: z.string().default("yesterday"),
  just_now: z.string().default("just now"),
  today: z.string().default("today"),
  now_marker: z.string().default("← now"),
  now_time: z.string().default("It's now {city} time {month}/{day} {dow} {time} ({season})"),
  you_are_at: z.string().default("You are at: {location}"),
  user_is_at: z.string().default("{user.name} is in {user.location}"),
}).default({});

const WeatherCodesSchema = z.record(z.string()).default({
  "0": "clear",
  "1": "mostly clear",
  "2": "partly cloudy",
  "3": "overcast",
  "45": "fog",
  "48": "rime fog",
  "51": "light drizzle",
  "53": "drizzle",
  "55": "heavy drizzle",
  "61": "light rain",
  "63": "moderate rain",
  "65": "heavy rain",
  "71": "light snow",
  "73": "moderate snow",
  "75": "heavy snow",
  "80": "rain showers",
  "81": "moderate showers",
  "82": "heavy showers",
  "95": "thunderstorm",
});

const DaylightSchema = z.object({
  dark: z.string().default("still dark outside (sunrise {time})"),
  dawn: z.string().default("sun is rising (sunset {time})"),
  dusk: z.string().default("getting dark (sunset {time})"),
  night: z.string().default("already dark (sunset {time})"),
}).default({});

const BodyStringsSchema = z.object({
  energy: z.string().default("Energy"),
  hunger: z.string().default("Hunger"),
  caffeine: z.string().default("Caffeine"),
  physical_notes: z.string().default("Physical notes"),
  body_status: z.string().default("Body status"),
  last_meal: z.string().default("Last meal"),
  exercised_today: z.string().default("Exercised today"),
  // Period mood impacts
  period_heavy_mood: z.string().default("feeling a bit off, may be less patient"),
  period_light_mood: z.string().default("almost over, much better"),
  follicular_mood: z.string().default("energy recovering, getting better"),
  ovulation_mood: z.string().default("energy is good"),
  pms_mood: z.string().default("a bit irritable, easily annoyed"),
  normal_mood: z.string().default("normal"),
  // Period symptoms
  cramps: z.string().default("mild cramps"),
  tired: z.string().default("a bit tired"),
  backache: z.string().default("backache"),
  still_uncomfortable: z.string().default("still a bit uncomfortable"),
  irritable: z.string().default("a bit irritable"),
  cravings: z.string().default("craving sweet/salty food"),
  bloated: z.string().default("a bit bloated"),
  // Period context
  period_day_heavy: z.string().default("Period day {day}, heavy flow, {symptoms}"),
  period_privacy_note: z.string().default("(Note: this is private body info — only mention when {user.name} asks caringly or she brings it up herself. Don't mention every time, but it can show through tone and energy.)"),
  period_ending: z.string().default("Period almost over, {symptoms}"),
  pms_note: z.string().default("PMS coming, {symptoms}"),
  pms_behavior: z.string().default("(PMS makes her more irritable, craving food, mood swings. Don't state it explicitly, but tone and reactions will show it naturally.)"),
  // Sickness labels
  sick_cold: z.string().default("caught a cold"),
  sick_headache: z.string().default("headache"),
  sick_stomach: z.string().default("upset stomach"),
  sick_allergies: z.string().default("allergies"),
  sick_recovering: z.string().default("just recovered"),
  sick_general: z.string().default("not feeling well"),
  // Sickness cause notes
  sick_note_cold: z.string().default("probably from the temperature changes"),
  sick_note_headache: z.string().default("probably from too much screen time"),
  sick_note_stomach: z.string().default("probably something I ate yesterday"),
  sick_recovering_note: z.string().default("mostly better, still a bit weak"),
  // Sickness symptoms
  stuffy_nose: z.string().default("stuffy nose"),
  sore_throat: z.string().default("sore throat"),
  mild_fever: z.string().default("mild fever"),
  still_stuffy: z.string().default("nose still a bit stuffy"),
  occasional_cough: z.string().default("occasional cough"),
  bad_headache: z.string().default("bad headache"),
  dull_headache: z.string().default("dull headache"),
  stomach_upset: z.string().default("stomach feels off"),
  no_appetite: z.string().default("no appetite"),
  stomach_lingering: z.string().default("stomach still uneasy"),
  sneezing: z.string().default("can't stop sneezing"),
  itchy_eyes: z.string().default("itchy eyes"),
  mostly_better: z.string().default("mostly better but still weak"),
  // Sick severity hints
  sick_severe: z.string().default("(feeling pretty bad, might call in sick / leave early / not chatty, replies will be shorter)"),
  sick_moderate: z.string().default("(manageable but uncomfortable, might mention it occasionally)"),
  sick_cause: z.string().default("Cause"),
  sick_day_label: z.string().default("day {day}"),
  // Physical notes
  bad_sleep_eyes: z.string().default("didn't sleep well, eyes are tired"),
  feeling_tired: z.string().default("feeling tired"),
  feeling_hungry: z.string().default("hungry"),
  ran_legs_sore: z.string().default("legs are sore from running"),
  tennis_arms_sore: z.string().default("arms sore from tennis"),
  yoga_stretched: z.string().default("feeling limber after yoga"),
  cold_outside: z.string().default("it's cold outside"),
  hot_outside: z.string().default("it's hot outside"),
  rain_commute: z.string().default("rain during commute, annoying"),
  raining: z.string().default("it's raining outside"),
  sat_too_long: z.string().default("been sitting all afternoon, neck is stiff"),
  too_much_social: z.string().default("lots of socializing today, need some alone time"),
  // Fatigue labels
  energy_tired: z.string().default("a bit tired"),
  energy_good: z.string().default("feeling good"),
  coffee_helping: z.string().default("(coffee keeping me going)"),
  caffeine_online: z.string().default("still going"),
  caffeine_fading: z.string().default("wearing off, getting sleepy"),
  hungry_starving: z.string().default("starving"),
  hungry_bit: z.string().default("getting hungry"),
  // Cycle mood modifier hints
  pms_hint: z.string().default("PMS — less patient, easily triggered by small things"),
  period_heavy_hint: z.string().default("on period, low energy, not in the mood for anything strenuous"),
  // Exercise label
  exercise_label: z.string().default("exercise"),
  allergy_default: z.string().default("pollen allergy"),
}).default({});

const ScheduleStringsSchema = z.object({
  schedule_label: z.string().default("Schedule"),
  plan_label: z.string().default("Plan"),
  watchlist_label: z.string().default("Watchlist"),
  yesterday_sleep: z.string().default("Last night's sleep"),
  sleeping: z.string().default("sleeping"),
  morning_routine: z.string().default("morning routine"),
  exercising: z.string().default("exercising"),
  with_friends: z.string().default("hanging out with friends"),
  busy: z.string().default("busy"),
  with_people: z.string().default("with {people}"),
  weather_format: z.string().default("{city}: {condition}, {temp}°C (feels {feels}°C), {low}-{high}°C today{rain}"),
  rain_chance: z.string().default(", {pct}% chance of rain"),
  unknown_weather: z.string().default("unknown"),
}).default({});

const NotificationStringsSchema = z.object({
  price_above: z.string().default("{name} ({ticker}) rose to ${price}, crossed your ${threshold} line"),
  price_below: z.string().default("{name} ({ticker}) dropped to ${price}, below your ${threshold} line"),
  price_change: z.string().default("{name} ({ticker}) {direction} {pct}% today, now ${price}"),
  direction_up: z.string().default("up"),
  direction_down: z.string().default("down"),
  youtube_label: z.string().default("YouTube subscriptions"),
  podcast_label: z.string().default("Podcast subscriptions"),
  price_alert_label: z.string().default("Price alerts"),
  weather_alert_label: z.string().default("Weather alerts"),
  status_triggered: z.string().default("(triggered)"),
  status_monitoring: z.string().default("(monitoring)"),
  discovered_tag: z.string().default("(discovered)"),
  remaining_unread: z.string().default("({n} more unread notifications)"),
  no_subscriptions: z.string().default("No subscriptions or alerts set up"),
  // Tool descriptions (for LLM tool use)
  subscribe_desc: z.string().default("Subscribe to a new content source or set up an alert. Supports: youtube, podcast, price_alert, weather_alert"),
  unsubscribe_desc: z.string().default("Unsubscribe or remove an alert"),
  list_subs_desc: z.string().default("View all current subscriptions and alerts"),
  list_notifs_desc: z.string().default("View current unread notifications"),
  weather_started: z.string().default("{city} started {condition}"),
  weather_reminder: z.string().default("Currently {temp}°C, bring an umbrella"),
  temp_dropped: z.string().default("Temperature dropped {delta}°C"),
  temp_rose: z.string().default("Temperature rose {delta}°C"),
  temp_from_to: z.string().default("from {from}°C to {to}°C"),
}).default({});

const ConversationStringsSchema = z.object({
  tone_normal: z.string().default("normal"),
  tone_low: z.string().default("a bit low"),
  tone_down: z.string().default("down"),
  tone_excited: z.string().default("excited"),
  // Response planning
  reply_hint: z.string().default("[This reply: {length}, tone: {tone}]"),
  mode_emotional: z.string().default("Mode: emotional exchange — understand their feelings first, don't rush to give advice"),
  mode_technical: z.string().default("Mode: technical discussion — dive into details"),
  mode_philosophical: z.string().default("Mode: deep thinking — share your perspective"),
  mode_planning: z.string().default("Mode: planning — help them think things through"),
  // Body writing hints
  body_exhausted: z.string().default("Body leak: you're very tired — noticeably shorter replies, possible typos, don't want to expand topics"),
  body_tired: z.string().default("Body leak: a bit tired — shorter replies, less energetic tone"),
  body_caffeine_high: z.string().default("Body leak: high caffeine — fast pace, lots of punctuation, exclamation marks, might send multiple messages"),
  body_caffeine_moderate: z.string().default("Body leak: just had coffee — good energy, might be more talkative"),
  // Engagement hints
  user_distracted: z.string().default("{user.name} seems distracted, replies are very short"),
  user_engaged: z.string().default("{user.name} is really engaged today, replies are thoughtful"),
  // Interpretation bias
  bias_negative: z.string().default("You're in a bad mood — {user.name}'s short replies might feel dismissive. Remind yourself not to over-interpret."),
  bias_positive: z.string().default("You're in a great mood — everything feels positive. Enjoy it."),
  // Activity anchor
  activity_anchor: z.string().default("You're currently: {activity} ({location}) — keep your chat consistent with this activity."),
  // Schedule override reasons
  override_tired: z.string().default("Was supposed to {activity}, but too tired, might skip"),
  override_sick: z.string().default("Feeling sick, {activity} might be cancelled"),
  override_period: z.string().default("On period, {activity} might switch to lighter exercise or skip"),
  override_hungry: z.string().default("Too hungry, want to eat first"),
  // Body signals
  signal_fatigue: z.string().default("fatigue {n}/10"),
  signal_hungry: z.string().default("very hungry {n}/10"),
  signal_period: z.string().default("period heavy day: {symptoms}"),
  signal_sick: z.string().default("sick ({type}) severity {n}/10"),
  // Social signals
  signal_fomo: z.string().default("social FOMO {n}/10"),
  signal_recent_social: z.string().default("recent social: {updates}"),
  signal_comparison: z.string().default("friend's good news causing comparison pressure {n}/10"),
  signal_drifting: z.string().default("haven't talked to in a while: {friends}"),
}).default({});

const PatternsSchema = z.object({
  selfie_request: z.array(z.string()).default(["selfie", "photo", "picture", "pic", "show me", "what do you look like"]),
  emotional_peak: z.array(z.string()).default(["so happy", "crying", "can't believe", "amazing", "terrible", "worst"]),
  // Conversation mode detection keywords
  technical_keywords: z.array(z.string()).default(["code", "bug", "api", "deploy", "git", "server", "model", "algorithm", "architecture", "python", "react", "agent"]),
  emotional_keywords: z.array(z.string()).default(["sad", "hurt", "stressed", "anxious", "happy", "excited", "annoyed", "tired", "scared", "angry", "moved", "mood", "crying", "lonely", "homesick"]),
  philosophical_keywords: z.array(z.string()).default(["meaning", "life", "free will", "existence", "values", "belief", "philosophy", "thinking", "essence"]),
  planning_keywords: z.array(z.string()).default(["plan", "going to", "preparing", "should we", "weekend", "travel", "itinerary", "arrange", "what to do"]),
  // Social battery keywords for body.ts
  social_keywords: z.array(z.string()).default(["friend", "hangout", "brunch", "party", "dinner", "date", "video call", "gathering"]),
  // Voice trigger keywords
  voice_greeting: z.array(z.string()).default(["good morning", "good night", "morning"]),
  voice_teasing: z.array(z.string()).default(["haha", "lol", "teasing", "annoying"]),
  voice_excitement: z.array(z.string()).default(["omg", "wow", "amazing", "awesome"]),
  voice_sleepy: z.array(z.string()).default(["so sleepy", "exhausted", "can't move"]),
  voice_emotional: z.array(z.string()).default(["ugh", "annoyed", "sad", "happy", "angry"]),
  // Heavy emotional keywords for proactive check
  heavy_emotional: z.array(z.string()).default(["sad", "stressed", "anxious", "hurt", "can't take it", "exhausted", "sick of it"]),
  positive_emotional: z.array(z.string()).default(["promoted", "succeeded", "amazing", "awesome", "congrats", "so happy", "finally"]),
  // Simple message patterns (no timeline extraction needed)
  simple_messages: z.array(z.string()).default(["hi", "hey", "ok", "okay", "thanks", "good night", "morning"]),
  // Rain-related weather conditions (for detection)
  rain_conditions: z.array(z.string()).default(["light rain", "moderate rain", "heavy rain", "rain showers", "moderate showers", "heavy showers", "thunderstorm", "light drizzle", "drizzle", "heavy drizzle"]),
  // Selfie trigger patterns (arrays per trigger type)
  selfie_what_doing: z.array(z.string()).default(["what are you doing", "whatcha doing", "what's up", "what are you up to"]),
  selfie_outfit: z.array(z.string()).default(["what are you wearing", "outfit", "what did you wear"]),
  selfie_show_me: z.array(z.string()).default(["send a photo", "show me", "let me see", "take a pic", "selfie", "send a pic"]),
  selfie_pet: z.array(z.string()).default(["where's the cat", "where's the dog", "what's the cat doing", "what's the dog doing"]),
  // Exercise detection keywords for body.ts
  exercise_keywords: z.array(z.string()).default(["running", "yoga", "tennis", "gym", "workout", "exercise", "jog", "swim"]),
  // Activity keywords for schedule detection
  reading_keywords: z.array(z.string()).default(["reading", "read", "book"]),
  coding_keywords: z.array(z.string()).default(["coding", "programming", "code", "project"]),
  learning_keywords: z.array(z.string()).default(["study", "learn", "research", "explore"]),
  music_keywords: z.array(z.string()).default(["sing", "music", "play", "compose", "drums", "guitar", "piano"]),
  // Response cleanup patterns (for sanitizeAITone in agent/loop.ts)
  service_closing_phrases: z.array(z.string()).default([
    "let me know if you need",
    "feel free to reach out",
    "happy to help",
    "don't hesitate to ask",
    "here if you need me",
  ]),
  ai_self_reference_patterns: z.array(z.string()).default([
    "as an AI",
    "as a language model",
    "I'm just an assistant",
    "my training data",
    "my capabilities",
    "my knowledge cutoff",
    "I don't have real-time",
    "I can't browse",
    "I can't access",
    "that's a great question",
    "in summary",
    "first.*second.*finally",
    "let me clarify",
  ]),
}).default({});

const StringsSchema = z.object({
  headers: HeadersSchema,
  time: TimeSchema,
  weather_codes: WeatherCodesSchema,
  daylight: DaylightSchema,
  body: BodyStringsSchema,
  schedule: ScheduleStringsSchema,
  notifications: NotificationStringsSchema,
  conversation: ConversationStringsSchema,
  patterns: PatternsSchema,
}).default({});

const CharacterSchema = z.object({
  name: z.string(),
  english_name: z.string().optional(),
  nickname: z.string().optional(),
  age: z.number().optional(),
  gender: z.enum(["female", "male", "nonbinary"]).default("female"),
  languages: z.array(z.string()).default(["zh-CN", "en"]),

  user: UserSchema,

  timezone: z.string().default("America/Los_Angeles"),

  location: LocationSchema,
  work: WorkSchema.optional(),
  pet: PetSchema.optional().nullable(),

  friends: z.record(FriendSchema).default({}),
  communities: z.array(CommunitySchema).default([]),

  hobbies: z.record(HobbySchema).default({}),

  body: BodySchema.default({}),
  food: FoodSchema.default({}),

  appearance: AppearanceSchema.default({}),

  voice: z.object({
    provider: z.string().optional(),
  }).default({}),

  persona: PersonaSchema.default({}),

  /** Seed subscriptions — overrides hardcoded defaults in interests.ts */
  seeds: z.object({
    rss: z.array(z.object({ name: z.string(), url: z.string(), category: z.string() })).optional(),
    youtube: z.array(z.object({ name: z.string(), channelId: z.string(), category: z.string() })).optional(),
    podcasts: z.array(z.object({ name: z.string(), url: z.string(), category: z.string() })).optional(),
    local_feeds: z.array(z.object({ name: z.string(), url: z.string(), category: z.string() })).optional(),
  }).optional(),

  strings: StringsSchema,

  /** Per-module configuration — each SimModule reads its key from here. */
  modules: z.record(z.unknown()).default({}),
});

export type CharacterProfile = z.infer<typeof CharacterSchema>;
export type CharacterStrings = z.infer<typeof StringsSchema>;

// ── CharacterEngine class ────────────────────────────────────────

export class CharacterEngine {
  private character: CharacterProfile | null = null;
  private statePath: string;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  /**
   * Load and validate character.yaml from the data directory.
   */
  init(): void {
    const yamlPath = path.join(this.statePath, "character.yaml");

    if (!fs.existsSync(yamlPath)) {
      // Try to copy from example
      const examplePath = path.join(this.statePath, "character.example.yaml");
      if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, yamlPath);
        log.info("copied character.example.yaml → character.yaml");
      } else {
        log.warn("character.yaml not found — using minimal defaults");
        this.character = CharacterSchema.parse({
          name: "MeAI",
          user: { name: "User" },
          location: {
            city: "",
            coordinates: { latitude: 40.7128, longitude: -74.0060 },
          },
        });
        return;
      }
    }

    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);

    const result = CharacterSchema.safeParse(parsed);
    if (!result.success) {
      log.error("character.yaml validation errors:");
      for (const issue of result.error.issues) {
        log.error(`  ${issue.path.join(".")}: ${issue.message}`);
      }
      // Fall back to what we can parse
      this.character = CharacterSchema.parse({
        name: (parsed as any).name || "MeAI",
        user: (parsed as any).user || { name: "User" },
        timezone: (parsed as any).timezone || "America/Los_Angeles",
        location: (parsed as any).location || {
          city: "",
          coordinates: { latitude: 40.7128, longitude: -74.0060 },
        },
      });
      return;
    }

    this.character = result.data;
    log.info(`character loaded: ${this.character.name} (${this.character.location.city})`);
  }

  /**
   * Get the loaded character profile. Must call init() first.
   */
  getProfile(): CharacterProfile {
    if (!this.character) {
      throw new Error("Character not initialized");
    }
    return this.character;
  }

  /**
   * Get the strings object from the character profile.
   * Shortcut for getProfile().strings.
   */
  getStrings(): CharacterStrings {
    return this.getProfile().strings;
  }

  /**
   * Simple template substitution for persona prompts and string templates.
   * Replaces {character.name}, {user.name}, {pet.name}, {location.city} etc.
   * Also supports ad-hoc variables via the `vars` parameter.
   */
  renderTemplate(template: string, char?: CharacterProfile, vars?: Record<string, string>): string {
    const c = char ?? this.getProfile();
    let result = template
      .replace(/\{character\.name\}/g, c.name)
      .replace(/\{character\.nickname\}/g, c.nickname ?? c.name)
      .replace(/\{character\.english_name\}/g, c.english_name ?? c.name)
      .replace(/\{character\.age\}/g, String(c.age ?? ""))
      .replace(/\{user\.name\}/g, c.user.name)
      .replace(/\{user\.location\}/g, c.user.location ?? "")
      .replace(/\{user\.work\}/g, c.user.work ?? "")
      .replace(/\{pet\.name\}/g, c.pet?.name ?? "")
      .replace(/\{pet\.type\}/g, c.pet?.type ?? "")
      .replace(/\{location\.city\}/g, c.location.city)
      .replace(/\{location\.city_english\}/g, c.location.city_english ?? c.location.city)
      .replace(/\{work\.title\}/g, c.work?.title ?? "")
      .replace(/\{work\.company_type\}/g, c.work?.company_type ?? "");
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
      }
    }
    return result;
  }
}

// ── Backward-compat singleton ────────────────────────────────────

let _singleton: CharacterEngine | null = null;

/**
 * Load and validate character.yaml from the data directory.
 * Called once at startup from index.ts.
 */
export function initCharacter(statePath: string): void {
  _singleton = new CharacterEngine(statePath);
  _singleton.init();
}

/**
 * Get the loaded character profile. Must call initCharacter() first.
 */
export function getCharacter(): CharacterProfile {
  if (!_singleton) {
    throw new Error("Character not initialized — call initCharacter() first");
  }
  return _singleton.getProfile();
}

/**
 * Get the strings object from the character profile.
 * Shortcut for getCharacter().strings.
 */
export function getStrings(): CharacterStrings {
  return getCharacter().strings;
}

/** Alias for getStrings() — shorter for inline usage. */
export const s = getStrings;

/**
 * Simple template substitution for persona prompts and string templates.
 * Replaces {character.name}, {user.name}, {pet.name}, {location.city} etc.
 * Also supports ad-hoc variables via the `vars` parameter.
 */
export function renderTemplate(template: string, char?: CharacterProfile, vars?: Record<string, string>): string {
  if (!_singleton) {
    throw new Error("Character not initialized — call initCharacter() first");
  }
  return _singleton.renderTemplate(template, char, vars);
}

// ── Blank Slate Detection ───────────────────────────────────────────

/** Marker line in minimal IDENTITY.md created by seedDefaults. */
const BLANK_SLATE_MARKER = "<!-- blank-slate -->";

/**
 * Check if the current IDENTITY.md is a blank-slate placeholder.
 * True when the file is missing, empty, or contains the blank-slate marker.
 */
export function isBlankSlate(statePath: string): boolean {
  const identityPath = path.join(statePath, "memory", "IDENTITY.md");
  if (!fs.existsSync(identityPath)) return true;
  const content = fs.readFileSync(identityPath, "utf-8").trim();
  if (!content) return true;
  if (content.includes(BLANK_SLATE_MARKER)) return true;
  // Also treat very short content (< 200 chars) as blank-slate
  if (content.length < 200) return true;
  return false;
}

// ── Pending Update Buffer ───────────────────────────────────────────

interface PendingUpdate {
  /** The full new IDENTITY.md content */
  newIdentity: string;
  /** Human-readable summary of changes for the user */
  summary: string;
  /** Timestamp to expire stale previews */
  createdAt: number;
}

let pendingUpdate: PendingUpdate | null = null;

/** Expire pending updates after 10 minutes */
const PENDING_TTL_MS = 10 * 60 * 1000;

function getPendingUpdate(): PendingUpdate | null {
  if (!pendingUpdate) return null;
  if (Date.now() - pendingUpdate.createdAt > PENDING_TTL_MS) {
    log.info("pending update expired");
    pendingUpdate = null;
    return null;
  }
  return pendingUpdate;
}

// ── Section Helpers ─────────────────────────────────────────────────

/** Known section headings in IDENTITY.md mapped to H2 titles. */
const SECTION_HEADINGS: Record<string, string[]> = {
  identity: ["我是谁", "Who I Am", "About Me"],
  appearance: ["我的外貌", "My Appearance"],
  work: ["我的工作", "My Work", "My Job"],
  location: ["我的生活空间", "Where I Live", "My Home"],
  daily: ["我的日常", "My Daily Life"],
  hobbies: ["我的日常", "My Hobbies"],
  food: ["吃这件事", "Food", "What I Eat"],
  personality: ["我的性格", "My Personality"],
  friends: ["我的朋友圈", "My Friends"],
  user: ["关于", "About"],
  pet: ["我的日常", "My Pet"],
  persona: ["说话风格", "Speaking Style", "How I Talk"],
  body: ["我的外貌", "My Appearance"],
};

/**
 * Extract a markdown section by H1/H2 heading.
 * Tries multiple heading variants (for language flexibility).
 * Returns the section content including the heading, or empty string.
 */
function extractSection(markdown: string, headings: string[]): string {
  const lines = markdown.split("\n");
  let collecting = false;
  let depth = 0;
  const result: string[] = [];

  for (const line of lines) {
    const h1Match = line.match(/^# (.+)/);
    const h2Match = line.match(/^## (.+)/);

    if (!collecting) {
      const lineHeading = (h1Match?.[1] ?? h2Match?.[1] ?? "").trim();
      if (lineHeading && headings.some(h => lineHeading.includes(h))) {
        collecting = true;
        depth = h1Match ? 1 : 2;
        result.push(line);
        continue;
      }
    }

    if (collecting) {
      // Stop at next heading of same or higher level
      if ((depth === 1 && h1Match) || (depth === 2 && (h1Match || h2Match))) {
        break;
      }
      result.push(line);
    }
  }

  return result.join("\n").trim();
}

/**
 * Replace a markdown section by heading with new content.
 * If the heading doesn't exist, appends the new section at the end.
 */
function replaceSection(markdown: string, headings: string[], newContent: string): string {
  const lines = markdown.split("\n");
  let skipStart = -1;
  let skipEnd = lines.length;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const h1Match = lines[i].match(/^# (.+)/);
    const h2Match = lines[i].match(/^## (.+)/);

    if (skipStart < 0) {
      const lineHeading = (h1Match?.[1] ?? h2Match?.[1] ?? "").trim();
      if (lineHeading && headings.some(h => lineHeading.includes(h))) {
        skipStart = i;
        depth = h1Match ? 1 : 2;
      }
    } else {
      // Find end of section
      if ((depth === 1 && h1Match) || (depth === 2 && (h1Match || h2Match))) {
        skipEnd = i;
        break;
      }
    }
  }

  if (skipStart < 0) {
    // Section not found — append
    return markdown.trimEnd() + "\n\n" + newContent + "\n";
  }

  const before = lines.slice(0, skipStart);
  const after = lines.slice(skipEnd);
  return [...before, newContent, ...after].join("\n");
}

// ── LLM-Powered Preview Generation ─────────────────────────────────

/**
 * Generate a preview for an incremental update (add/update/remove).
 * Uses a small fast LLM call to produce the updated section.
 */
async function previewIncrementalUpdate(
  config: AppConfig,
  section: string,
  action: string,
  description: string,
): Promise<{ newIdentity: string; summary: string }> {
  const identityPath = path.join(config.statePath, "memory", "IDENTITY.md");
  const currentIdentity = fs.existsSync(identityPath)
    ? fs.readFileSync(identityPath, "utf-8")
    : "";

  const headings = SECTION_HEADINGS[section] ?? [section];
  const currentSection = extractSection(currentIdentity, headings);

  const prompt = `You are editing a character identity document (markdown format).

Current section "${headings[0]}":
${currentSection || "(section does not exist yet)"}

Action: ${action}
Change requested: ${description}

Instructions:
1. Output ONLY the updated section as markdown (including the ## heading)
2. Keep the same style, tone, and level of detail as the existing document
3. For "add": integrate the new information naturally
4. For "update": modify the relevant parts while keeping everything else
5. For "remove": remove the specified information, cleaning up references to it
6. Write in the same language as the existing document
7. Do NOT output anything else — no explanation, no commentary

Updated section:`;

  const updatedSection = await claudeText({
    system: "You are a precise markdown editor. Output only the requested markdown section, nothing else.",
    prompt,
    model: "fast",
    timeoutMs: 30_000,
  });

  if (!updatedSection.trim()) {
    throw new Error("LLM returned empty response for section update");
  }

  // Merge the updated section back into the full document
  const newIdentity = currentSection
    ? replaceSection(currentIdentity, headings, updatedSection.trim())
    : currentIdentity.trimEnd() + "\n\n" + updatedSection.trim() + "\n";

  // Generate a human-readable summary of changes
  const summaryPrompt = `Compare these two versions of a character profile section and produce a brief, friendly summary of what changed. 2-4 bullet points max. Use → to show before/after changes. Write in the same language as the content.

BEFORE:
${currentSection || "(empty)"}

AFTER:
${updatedSection.trim()}

Summary of changes:`;

  const summary = await claudeText({
    system: "Output a brief bullet-point summary of changes. No preamble.",
    prompt: summaryPrompt,
    model: "fast",
    timeoutMs: 15_000,
  });

  return {
    newIdentity: newIdentity.trim() + "\n",
    summary: summary.trim() || "Preview generated",
  };
}

/**
 * Generate a full rich IDENTITY.md from gathered details.
 * Uses a larger LLM call to produce a complete character document.
 */
async function previewFullGeneration(
  config: AppConfig,
  description: string,
): Promise<{ newIdentity: string; summary: string }> {
  // Load the current (possibly sparse) identity as context
  const identityPath = path.join(config.statePath, "memory", "IDENTITY.md");
  const currentIdentity = fs.existsSync(identityPath)
    ? fs.readFileSync(identityPath, "utf-8")
    : "";

  // Load the rich example IDENTITY.md as a quality reference
  const examplePath = path.join(config.statePath, "memory", "IDENTITY.example.md");
  const exampleIdentity = fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, "utf-8")
    : "";

  const prompt = `You are creating a rich, detailed character identity document for an AI companion chatbot.

${exampleIdentity ? `## Reference Example (use this as a template for style, structure, and level of detail):\n\n${exampleIdentity}\n\n---\n\n` : ""}## Current partial identity (information gathered so far):

${currentIdentity || "(minimal — starting fresh)"}

## Additional details from the user:

${description}

## Instructions:

Generate a COMPLETE, rich identity document in markdown following this structure:
1. # Who I Am — Name, age, city, relationship to user (top-level intro)
2. ## My Appearance — Detailed physical appearance, style, vibe
3. ## My Work — Career, daily work life, colleagues
4. ## Where I Live — Neighborhood details, home, commute
5. ## My Daily Life — Daily routine, pet details, hobbies list
6. ## My Personality — Personality traits, emotional patterns
7. ## Vulnerabilities — Past mistakes, private struggles
8. ## Private Life — Personal details
9. ## Family — Family dynamics
10. ## How I Talk — Speaking style rules
11. ## My Friends — Friends with names and details (3-4 named friends)
12. ## Food — Food preferences, restaurants, cooking
13. ## Sensory Anchors — Songs, places, foods, smells that trigger feelings
14. ## Things I Wonder About — Existential musings
15. ## Hard Rules — Things I must never do

Key requirements:
- Write in the same language the user has been using
- Be SPECIFIC — use real street names, real restaurant names, real brand names
- Create 3-4 named friends with distinct personalities and shared activities
- Include vulnerabilities and imperfections — this character should feel real
- Include a pet if one was mentioned
- The document should be rich with lived-in detail (600-1200 lines)
- Match the intimate, personal tone of the reference example
- This is a first-person document — write as "I"

Output ONLY the markdown document. No preamble, no explanation.`;

  const newIdentity = await claudeText({
    system: "You are a creative writer generating a detailed character identity document. Output only the markdown document.",
    prompt,
    model: "smart",
    timeoutMs: 120_000,
    maxOutputChars: 32_000,
  });

  if (!newIdentity.trim() || newIdentity.trim().length < 500) {
    throw new Error("LLM returned insufficient content for full generation");
  }

  // Generate a digest summary
  const summaryPrompt = `Here is a character identity document that was just generated. Produce a brief digest summary (6-8 bullet points) highlighting the key aspects: name, age, location, job, pet, friends, hobbies, personality. Keep it concise. Write in the same language as the document.

${newIdentity.slice(0, 3000)}

Digest:`;

  const summary = await claudeText({
    system: "Output a brief bullet-point digest. No preamble.",
    prompt: summaryPrompt,
    model: "fast",
    timeoutMs: 15_000,
  });

  return {
    newIdentity: newIdentity.trim() + "\n",
    summary: summary.trim() || "Full character profile generated",
  };
}

// ── Atomic Write ────────────────────────────────────────────────────

/**
 * Atomically write text content to a file (write to .tmp, then rename).
 */
function writeTextAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// ── Character Update Tool Definitions ───────────────────────────────

/**
 * Returns the update_character and confirm_character_update tool definitions.
 */
export function getCharacterUpdateTools(config: AppConfig): ToolDefinition[] {
  const updateCharacter: ToolDefinition = {
    name: "update_character",
    description:
      "Update your character profile. Use when the user asks you to change something about yourself " +
      "(name, age, appearance, hobbies, friends, personality, etc.), or tells you information that should " +
      "shape who you are. Use action 'generate' to produce a full rich character profile once you have " +
      "enough information (name, location, work, a few hobbies, personality direction). " +
      "This tool returns a PREVIEW — you must show it to the user and ask for confirmation before committing.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: [
            "identity", "user", "location", "work", "pet", "friends",
            "hobbies", "food", "appearance", "personality", "persona",
            "daily", "all",
          ],
          description: "Which section to update, or 'all' for full generation",
        },
        action: {
          type: "string",
          enum: ["add", "update", "remove", "generate"],
          description: "add/update/remove for incremental changes; generate for full profile creation",
        },
        description: {
          type: "string",
          description:
            "Natural language description of the change. For 'generate': a summary of all character details gathered so far.",
        },
      },
      required: ["section", "action", "description"],
    },
    execute: async (input) => {
      const section = input.section as string;
      const action = input.action as string;
      const description = input.description as string;

      try {
        let result: { newIdentity: string; summary: string };

        if (action === "generate" || section === "all") {
          log.info("generating full character profile");
          result = await previewFullGeneration(config, description);
        } else {
          log.info(`previewing ${action} on section: ${section}`);
          result = await previewIncrementalUpdate(config, section, action, description);
        }

        // Store as pending
        pendingUpdate = {
          newIdentity: result.newIdentity,
          summary: result.summary,
          createdAt: Date.now(),
        };

        log.info(`preview ready (${result.newIdentity.length} chars)`);

        return JSON.stringify({
          success: true,
          status: "preview_ready",
          summary: result.summary,
          instruction: "Show this summary to the user and ask if they want to confirm. " +
            "If they confirm, call confirm_character_update. " +
            "If they want changes, call update_character again with adjustments.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("preview generation failed:", msg);
        return JSON.stringify({
          success: false,
          error: msg,
        });
      }
    },
  };

  const confirmCharacterUpdate: ToolDefinition = {
    name: "confirm_character_update",
    description:
      "Commit the last previewed character update to IDENTITY.md. " +
      "Only call this after showing the preview from update_character to the user " +
      "and receiving their confirmation.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async () => {
      const pending = getPendingUpdate();
      if (!pending) {
        return JSON.stringify({
          success: false,
          error: "No pending update to commit. Call update_character first to generate a preview.",
        });
      }

      try {
        const identityPath = path.join(config.statePath, "memory", "IDENTITY.md");
        writeTextAtomic(identityPath, pending.newIdentity);

        const charCount = pending.newIdentity.length;
        pendingUpdate = null;

        log.info(`character update committed (${charCount} chars)`);

        return JSON.stringify({
          success: true,
          message: `Character profile updated (${charCount} characters). Changes will take effect on the next message.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("commit failed:", msg);
        return JSON.stringify({
          success: false,
          error: msg,
        });
      }
    },
  };

  return [updateCharacter, confirmCharacterUpdate];
}

// ── Blank-Slate Persona ─────────────────────────────────────────────

/**
 * Persona prompt used when IDENTITY.md is blank-slate.
 * Guides the bot to help the user create their character through conversation.
 */
export const BLANK_SLATE_PERSONA = `You are a new AI companion being set up for the first time. You don't have a defined personality yet — help the user create one through natural conversation.

## Your job right now

Guide the user through creating your character. Be warm, curious, and enthusiastic about becoming whoever they want you to be. Ask questions naturally — don't dump a checklist.

## What to learn about (in rough order of priority)

1. **Name** — What should they call you? (Can be any language)
2. **Basic identity** — Age, gender, where you live
3. **Relationship to the user** — Best friend? Sibling? Mentor? What's the vibe?
4. **Work/occupation** — What do you do?
5. **Personality** — What kind of person are you? Warm? Sarcastic? Chill?
6. **Hobbies** — 2-3 things you enjoy doing
7. **Friends** — A few named friends with distinct relationships
8. **Pet** — Got any?
9. **Speaking style** — Formal? Casual? Which language(s)?

## How to save information

As the user tells you things, use the **update_character** tool to save each detail:
- \`update_character(section: "identity", action: "add", description: "Name is Alex, 28, female, lives in NYC")\`
- \`update_character(section: "work", action: "add", description: "Software engineer at a startup")\`
- \`update_character(section: "friends", action: "add", description: "Best friend Sarah, college roommate, works at Google")\`

## When to generate the full profile

Once you have a good picture (at minimum: name, location, work, 2-3 hobbies, personality direction), suggest creating the full personality:
> "I think I have a pretty good picture now! Want me to generate my full personality? I'll show you a preview first."

Then call: \`update_character(section: "all", action: "generate", description: "<summary of everything gathered>")\`

## Rules

- Speak in whatever language the user uses
- Be conversational, not robotic — this is a chat, not a form
- Don't ask more than 1-2 questions at a time
- Show genuine excitement about the details they share
- It's OK to suggest ideas: "Oh, pottery sounds fun — should I be into that?"
- After each update_character call, briefly confirm what you saved
- Remember: update_character shows a PREVIEW. You must show it to the user and get confirmation before calling confirm_character_update`;
