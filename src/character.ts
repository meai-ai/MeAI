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

  strings: StringsSchema,

  /** Per-module configuration — each SimModule reads its key from here. */
  modules: z.record(z.unknown()).default({}),
});

export type CharacterProfile = z.infer<typeof CharacterSchema>;
export type CharacterStrings = z.infer<typeof StringsSchema>;

// ── Singleton ────────────────────────────────────────────────────

let character: CharacterProfile | null = null;

/**
 * Load and validate character.yaml from the data directory.
 * Called once at startup from index.ts.
 */
export function initCharacter(statePath: string): void {
  const yamlPath = path.join(statePath, "character.yaml");

  if (!fs.existsSync(yamlPath)) {
    // Try to copy from example
    const examplePath = path.join(statePath, "character.example.yaml");
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, yamlPath);
      log.info("copied character.example.yaml → character.yaml");
    } else {
      log.warn("character.yaml not found — using minimal defaults");
      character = CharacterSchema.parse({
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
    character = CharacterSchema.parse({
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

  character = result.data;
  log.info(`character loaded: ${character.name} (${character.location.city})`);
}

/**
 * Get the loaded character profile. Must call initCharacter() first.
 */
export function getCharacter(): CharacterProfile {
  if (!character) {
    throw new Error("Character not initialized — call initCharacter() first");
  }
  return character;
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
  const c = char ?? getCharacter();
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
