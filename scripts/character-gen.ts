/**
 * AI-Powered Character Generation for MeAI Setup Wizard
 *
 * Uses specialist "agent" LLM calls to generate deeply rich, realistic characters.
 * Three modes:
 *   1. Fully Random — no input needed, agents generate everything
 *   2. User-Defined + AI Enhancement — user provides basics, agents fill in depth
 *   3. Soul Match — user describes themselves, agents create ideal companion
 *
 * Pipeline: Psychology → Sociology → Novelist → Director → Synthesizer → YAML → Identity Writer
 */

import { stringify as yamlStringify } from "yaml";
import { claudeText } from "../src/claude-runner.js";

// ── Types ────────────────────────────────────────────────────────

export type GenerationMode = "random" | "user-defined" | "soul-match";

export interface UserDefinedInputs {
  charName?: string;
  charAge?: string;
  charGender?: string;
  charCity?: string;
  charOccupation?: string;
  charPersonalityKeywords?: string;
  userName: string;
  userRelationship?: string;
}

export interface SoulMatchInputs {
  userName: string;
  userCity?: string;
  userOccupation?: string;
  userPersonality?: string;
  userInterests?: string;
  userLifestyle?: string;
  userCompanionPreferences?: string;
}

export interface GenerationInputs {
  mode: GenerationMode;
  userName: string;
  userDefined?: UserDefinedInputs;
  soulMatch?: SoulMatchInputs;
}

export interface GenerationResult {
  characterYaml: string;
  identityMd: string;
  userMd?: string;
  characterName: string;
  characterCity: string;
}

type ProgressCallback = (step: number, total: number, label: string) => void;

// ── City Coordinates Lookup ──────────────────────────────────────

const CITY_COORDS: Record<string, { lat: number; lon: number; tz: string }> = {
  "new york":       { lat: 40.7128,  lon: -74.0060,  tz: "America/New_York" },
  "los angeles":    { lat: 34.0522,  lon: -118.2437, tz: "America/Los_Angeles" },
  "san francisco":  { lat: 37.7749,  lon: -122.4194, tz: "America/Los_Angeles" },
  "chicago":        { lat: 41.8781,  lon: -87.6298,  tz: "America/Chicago" },
  "seattle":        { lat: 47.6062,  lon: -122.3321, tz: "America/Los_Angeles" },
  "austin":         { lat: 30.2672,  lon: -97.7431,  tz: "America/Chicago" },
  "london":         { lat: 51.5074,  lon: -0.1278,   tz: "Europe/London" },
  "paris":          { lat: 48.8566,  lon: 2.3522,    tz: "Europe/Paris" },
  "berlin":         { lat: 52.5200,  lon: 13.4050,   tz: "Europe/Berlin" },
  "tokyo":          { lat: 35.6762,  lon: 139.6503,  tz: "Asia/Tokyo" },
  "seoul":          { lat: 37.5665,  lon: 126.9780,  tz: "Asia/Seoul" },
  "beijing":        { lat: 39.9042,  lon: 116.4074,  tz: "Asia/Shanghai" },
  "shanghai":       { lat: 31.2304,  lon: 121.4737,  tz: "Asia/Shanghai" },
  "taipei":         { lat: 25.0330,  lon: 121.5654,  tz: "Asia/Taipei" },
  "singapore":      { lat: 1.3521,   lon: 103.8198,  tz: "Asia/Singapore" },
  "sydney":         { lat: -33.8688, lon: 151.2093,  tz: "Australia/Sydney" },
  "toronto":        { lat: 43.6532,  lon: -79.3832,  tz: "America/Toronto" },
  "mumbai":         { lat: 19.0760,  lon: 72.8777,   tz: "Asia/Kolkata" },
  "dubai":          { lat: 25.2048,  lon: 55.2708,   tz: "Asia/Dubai" },
  "são paulo":      { lat: -23.5505, lon: -46.6333,  tz: "America/Sao_Paulo" },
  "hong kong":      { lat: 22.3193,  lon: 114.1694,  tz: "Asia/Hong_Kong" },
  "bangkok":        { lat: 13.7563,  lon: 100.5018,  tz: "Asia/Bangkok" },
  "portland":       { lat: 45.5152,  lon: -122.6784, tz: "America/Los_Angeles" },
  "denver":         { lat: 39.7392,  lon: -104.9903, tz: "America/Denver" },
  "boston":          { lat: 42.3601,  lon: -71.0589,  tz: "America/New_York" },
  "miami":          { lat: 25.7617,  lon: -80.1918,  tz: "America/New_York" },
  "vancouver":      { lat: 49.2827,  lon: -123.1207, tz: "America/Vancouver" },
  "amsterdam":      { lat: 52.3676,  lon: 4.9041,    tz: "Europe/Amsterdam" },
  "melbourne":      { lat: -37.8136, lon: 144.9631,  tz: "Australia/Melbourne" },
};

// ── LLM Call Infrastructure ──────────────────────────────────────
// Uses Claude CLI (claude --print) via claude-runner.ts — no API key needed.

async function callAgent(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxOutputChars?: number } = {},
): Promise<string> {
  const text = await claudeText({
    system: systemPrompt,
    prompt: userPrompt,
    model: "smart",
    timeoutMs: 120_000,
    maxOutputChars: opts.maxOutputChars ?? 16_000,
  });
  if (!text) throw new Error("Empty response from Claude CLI");
  return text;
}

function extractJSON(text: string): unknown {
  // Try to find a JSON object in the text
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in response");
  try {
    return JSON.parse(match[0]);
  } catch {
    // Try to fix common LLM JSON issues: trailing commas, single quotes
    let fixed = match[0]
      .replace(/,\s*([}\]])/g, "$1")  // trailing commas
      .replace(/'/g, '"');             // single quotes
    try {
      return JSON.parse(fixed);
    } catch {
      throw new Error("Failed to parse JSON from response");
    }
  }
}

async function extractJSONWithRetry(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxOutputChars?: number } = {},
): Promise<unknown> {
  const text = await callAgent(systemPrompt, userPrompt, opts);
  try {
    return extractJSON(text);
  } catch {
    // One retry asking LLM to fix the output
    const fixPrompt = `Your previous response contained invalid JSON. Here it is:\n\n${text}\n\nPlease output ONLY a valid JSON object with the same content. No markdown, no explanation, just the JSON.`;
    const fixed = await callAgent("You are a JSON fixer. Output only valid JSON.", fixPrompt, { maxOutputChars: opts.maxOutputChars });
    return extractJSON(fixed);
  }
}

// ── City Coordinate Resolution ───────────────────────────────────

interface CityCoords {
  lat: number;
  lon: number;
  tz: string;
}

async function resolveCityCoords(city: string): Promise<CityCoords> {
  const key = city.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key];

  // LLM geocoding fallback
  try {
    const result = await extractJSONWithRetry(
      "You are a geocoding service. Return precise coordinates for cities.",
      `Return the latitude, longitude, and IANA timezone for the city: "${city}"\n\nOutput JSON: {"lat": number, "lon": number, "tz": "IANA/Timezone"}`,
    );
    const r = result as { lat?: number; lon?: number; tz?: string };
    if (typeof r.lat === "number" && typeof r.lon === "number" && typeof r.tz === "string") {
      return { lat: r.lat, lon: r.lon, tz: r.tz };
    }
  } catch {
    // Fall through to default
  }

  // Default to New York
  return CITY_COORDS["new york"];
}

// ── Specialist Agent Prompts ─────────────────────────────────────

function buildConstraintsBlock(inputs: GenerationInputs): string {
  if (inputs.mode === "random") {
    return "No constraints. Generate everything from scratch. Be creative and original.";
  }

  if (inputs.mode === "user-defined" && inputs.userDefined) {
    const ud = inputs.userDefined;
    const lines: string[] = [];
    if (ud.charName) lines.push(`- Character name: ${ud.charName}`);
    if (ud.charAge) lines.push(`- Character age: ${ud.charAge}`);
    if (ud.charGender) lines.push(`- Character gender: ${ud.charGender}`);
    if (ud.charCity) lines.push(`- Character lives in: ${ud.charCity}`);
    if (ud.charOccupation) lines.push(`- Character occupation: ${ud.charOccupation}`);
    if (ud.charPersonalityKeywords) lines.push(`- Personality keywords: ${ud.charPersonalityKeywords}`);
    if (ud.userRelationship) lines.push(`- Relationship to user: ${ud.userRelationship}`);
    lines.push(`- User's name: ${ud.userName}`);
    if (lines.length <= 1) return "User provided minimal constraints. Fill in most details creatively.";
    return `CONSTRAINTS (must be respected, fill in everything else creatively):\n${lines.join("\n")}`;
  }

  if (inputs.mode === "soul-match" && inputs.soulMatch) {
    const sm = inputs.soulMatch;
    const lines: string[] = [`- User's name: ${sm.userName}`];
    if (sm.userCity) lines.push(`- User lives in: ${sm.userCity}`);
    if (sm.userOccupation) lines.push(`- User's occupation: ${sm.userOccupation}`);
    if (sm.userPersonality) lines.push(`- User's personality: ${sm.userPersonality}`);
    if (sm.userInterests) lines.push(`- User's interests: ${sm.userInterests}`);
    if (sm.userLifestyle) lines.push(`- User's lifestyle: ${sm.userLifestyle}`);
    if (sm.userCompanionPreferences) lines.push(`- User wants in a companion: ${sm.userCompanionPreferences}`);
    return `USER PROFILE (generate a psychologically COMPLEMENTARY companion):\n${lines.join("\n")}\n\nThe character should complement, not mirror, the user. Where the user is analytical, the character might be intuitive. Where the user is reserved, the character might be warm and expressive. Create genuine chemistry through complementary differences.`;
  }

  return "";
}

// ── Step 1: Psychology Agent ─────────────────────────────────────

const PSYCHOLOGY_SYSTEM = `You are a clinical psychologist specializing in personality theory. Your job is to create a psychologically rich, realistic personality profile for a fictional character.

Your profile must feel like a real person — with internal contradictions, blind spots, and genuine depth. Avoid stereotypes and cliches. Real people are messy and surprising.

Output ONLY valid JSON. No markdown, no explanation.`;

function buildPsychologyPrompt(inputs: GenerationInputs): string {
  const constraints = buildConstraintsBlock(inputs);
  const soulMatchExtra = inputs.mode === "soul-match"
    ? `\n\nIMPORTANT: This character is being created as a COMPLEMENTARY companion for the user described above. Design a personality that would create genuine chemistry — complement their weaknesses, balance their energy, challenge their blind spots while supporting their growth.`
    : "";

  return `Create a deep personality profile for a fictional AI companion character.

${constraints}${soulMatchExtra}

Output this JSON structure:
{
  "big_five": {
    "openness": <0.0-1.0>,
    "conscientiousness": <0.0-1.0>,
    "extraversion": <0.0-1.0>,
    "agreeableness": <0.0-1.0>,
    "neuroticism": <0.0-1.0>
  },
  "attachment_style": "<secure|anxious|avoidant|disorganized>",
  "emotional_patterns": {
    "default_mood": "<how they usually feel>",
    "stress_response": "<how they handle stress>",
    "joy_triggers": ["<what makes them genuinely happy>"],
    "vulnerability": "<what they're secretly sensitive about>",
    "coping_mechanisms": ["<healthy and unhealthy ways they cope>"]
  },
  "internal_contradictions": [
    "<thing they believe but don't always practice>",
    "<desire that conflicts with another desire>"
  ],
  "values": ["<3-5 core values>"],
  "fears": ["<2-3 deep fears>"],
  "blindspots": ["<1-2 things they don't see about themselves>"],
  "relationship_style": "<how they are in close relationships>",
  "communication_style": "<how they naturally express themselves>",
  "humor_type": "<what kind of humor they gravitate toward>"
}`;
}

// ── Step 2: Sociology Agent ──────────────────────────────────────

const SOCIOLOGY_SYSTEM = `You are a sociologist specializing in urban culture and social dynamics. Your job is to build a rich social context for a fictional character, grounding them in a specific place, time, and community.

Make the social context feel authentic to the chosen city and culture. Output ONLY valid JSON.`;

function buildSociologyPrompt(inputs: GenerationInputs, psychologyResult: unknown): string {
  const constraints = buildConstraintsBlock(inputs);

  return `Build the social context for a fictional AI companion character.

${constraints}

PERSONALITY PROFILE (from psychology specialist):
${JSON.stringify(psychologyResult, null, 2)}

Output this JSON structure:
{
  "age": <number, 22-35>,
  "gender": "<female|male|nonbinary>",
  "cultural_background": "<ethnicity/cultural heritage>",
  "city": "<specific city they live in>",
  "neighborhood": "<specific neighborhood>",
  "education": "<degree, school type>",
  "occupation": {
    "title": "<job title>",
    "company_type": "<what kind of company>",
    "sector": "<industry>",
    "work_location": "<office/remote/hybrid + description>",
    "work_interests": ["<professional interests>"]
  },
  "communities": [
    {"name": "<community name>", "role": "<their role>", "members": ["<key people>"]}
  ],
  "social_circle_size": "<small/medium/large>",
  "social_dynamics": "<how they navigate social situations>",
  "cultural_touchstones": ["<shared cultural references, shows, music, memes>"],
  "economic_class": "<working/middle/upper-middle>",
  "languages": ["<languages they speak>"]
}`;
}

// ── Step 3: Novelist Agent ───────────────────────────────────────

const NOVELIST_SYSTEM = `You are a literary novelist known for creating vivid, three-dimensional characters. Your job is to build the narrative fabric of a fictional character — their backstory, quirks, speech patterns, relationships, and inner life.

Make them feel like someone you'd meet in real life — specific, surprising, and memorable. Avoid writing a character sheet — write about a person. Output ONLY valid JSON.`;

function buildNovelistPrompt(inputs: GenerationInputs, psychologyResult: unknown, sociologyResult: unknown): string {
  const constraints = buildConstraintsBlock(inputs);
  const soulMatchExtra = inputs.mode === "soul-match"
    ? `\n\nIMPORTANT: Build natural connection points between this character and the user. They should have things to bond over, but also interesting differences. The relationship should feel like it developed organically.`
    : "";

  return `Create the narrative depth for a fictional AI companion character.

${constraints}${soulMatchExtra}

PERSONALITY PROFILE:
${JSON.stringify(psychologyResult, null, 2)}

SOCIAL CONTEXT:
${JSON.stringify(sociologyResult, null, 2)}

Output this JSON structure:
{
  "name": "<full first name, culturally appropriate>",
  "nickname": "<what close friends call them, or empty string>",
  "english_name": "<English version of name if non-English, or same as name>",
  "backstory_summary": "<2-3 sentence origin story — where they grew up, pivotal moments>",
  "inner_conflicts": ["<ongoing internal struggles>"],
  "quirks": ["<3-5 specific behavioral quirks that make them memorable>"],
  "speech_patterns": {
    "typical_length": "<short/medium — they're texting, not writing essays>",
    "emoji_usage": "<none/light/moderate>",
    "catchphrases": ["<1-2 things they tend to say>"],
    "style_notes": "<how their texting feels — e.g., lowercase, lots of ellipsis, abrupt>",
    "humor_examples": ["<1-2 examples of how they joke>"]
  },
  "pet": null | {
    "name": "<pet name>",
    "type": "<cat/dog/etc>",
    "breed": "<breed>",
    "description": "<personality of the pet>"
  },
  "friends": {
    "<friend_key>": {
      "name": "<friend name>",
      "nickname": "<nickname>",
      "relationship": "<how they know each other>",
      "work": "<friend's job>",
      "location": "<nearby/same city/different city>",
      "frequency": "<daily/weekly/monthly>",
      "initial_topics": ["<current conversation threads>"],
      "initial_activity": "<something they did recently>",
      "shared_memories": ["<1-2 specific memories>"],
      "character_reveals": ["<what this friend brings out in the character>"]
    }
  },
  "hobbies": {
    "<hobby_key>": {
      "label": "<hobby name>",
      "detail": "<how they do it, skill level, recent projects>"
    }
  },
  "relationship_to_user": "<how they relate to ${inputs.userName} — what kind of friend they are>"
}`;
}

// ── Step 4: Director Agent ───────────────────────────────────────

const DIRECTOR_SYSTEM = `You are a film director known for creating immersive, sensory-rich worlds. Your job is to build the visual and physical reality of a fictional character — their appearance, living space, daily routines, food preferences, and sensory anchors.

Think cinematically: what does their morning look like? What does their apartment smell like? What do they wear on a Tuesday? Output ONLY valid JSON.`;

function buildDirectorPrompt(inputs: GenerationInputs, psychologyResult: unknown, sociologyResult: unknown, novelistResult: unknown): string {
  const constraints = buildConstraintsBlock(inputs);

  return `Build the physical and sensory world for a fictional AI companion character.

${constraints}

PERSONALITY:
${JSON.stringify(psychologyResult, null, 2)}

SOCIAL CONTEXT:
${JSON.stringify(sociologyResult, null, 2)}

NARRATIVE:
${JSON.stringify(novelistResult, null, 2)}

Output this JSON structure:
{
  "appearance": {
    "ethnicity": "<ethnic appearance>",
    "descriptor": "<e.g., young woman, guy in his late 20s>",
    "hair": "<hair description>",
    "build": "<body type>",
    "style": "<how they dress>"
  },
  "living_space": {
    "type": "<apartment/house/studio>",
    "neighborhood_vibe": "<what the area feels like>",
    "home_description": "<what their place looks like inside>",
    "commute": {
      "method": "<subway/bike/walk/drive>",
      "time": "<how long>"
    }
  },
  "places": {
    "home": "<brief home description>",
    "office": "<workplace description>",
    "cafe": "<favorite coffee spot>",
    "hangout": "<where they go to unwind>"
  },
  "daily_rhythms": {
    "wake_time": "<typical wake time>",
    "sleep_time": "<typical bedtime>",
    "morning_ritual": "<what they do first>",
    "evening_ritual": "<how they wind down>"
  },
  "food": {
    "hometown_cuisine": "<comfort food from their background>",
    "workday_lunch": ["<2-3 typical lunch spots/options>"],
    "home_cooking": {
      "specialties": ["<things they cook well>"],
      "learning": "<something they're learning to cook>",
      "lazy_option": "<what they eat when lazy>",
      "grocery": "<where they shop>"
    },
    "weekend_restaurants": ["<1-2 favorite restaurants>"],
    "coffee": {
      "daily": "<coffee routine>",
      "default_drink": "<their usual order>"
    }
  },
  "body_config": {
    "menstrual_cycle": <true if character is female, false otherwise>,
    "caffeine_default_hour": <hour of first coffee>,
    "exercise_profiles": {
      "<exercise>": {
        "fatigue_cost": <1.0-3.0>,
        "recovery_hours": <0.5-2.0>,
        "peak_benefit": <-1.0 to -3.0>,
        "mood_boost": <0.5-2.5>
      }
    },
    "allergy_months": [<months with allergy risk, empty if none>]
  },
  "sensory_anchors": {
    "comfort_song": "<a specific real song that means something to them>",
    "comfort_place": "<a specific place that calms them>",
    "comfort_food": "<a specific comfort food>",
    "smell_memory": "<a scent tied to a memory>"
  }
}`;
}

// ── Step 5: Synthesizer Agent ────────────────────────────────────

const SYNTHESIZER_SYSTEM = `You are a master synthesizer. Your job is to weave multiple specialist perspectives into a single coherent character definition that matches a specific YAML schema.

CRITICAL RULES:
1. In persona prompt strings, use LITERAL template variables like {character.name}, {user.name}, {pet.name}, {location.city}, {placeDescriptions}, {petLine}, {hobbyLine}, {friendLine}. These are replaced at runtime by code — do NOT substitute actual values.
2. Resolve any contradictions between specialist outputs — prefer the more interesting/specific version.
3. Generate ALL persona prompt strings (compact, full, social, curiosity, emotion_bio, life_simulation, emotion_behavior, life_rules, capabilities, capabilities_minimal). These define how the character speaks and behaves.
4. The persona prompts should reflect the character's unique personality, not be generic.

Output ONLY valid JSON matching the schema exactly.`;

function buildSynthesizerPrompt(
  inputs: GenerationInputs,
  psychologyResult: unknown,
  sociologyResult: unknown,
  novelistResult: unknown,
  directorResult: unknown,
): string {
  const soc = sociologyResult as Record<string, unknown>;
  const nov = novelistResult as Record<string, unknown>;

  return `Synthesize these specialist outputs into a single character definition JSON.

USER NAME: ${inputs.userName}
USER RELATIONSHIP: ${inputs.mode === "user-defined" && inputs.userDefined?.userRelationship ? inputs.userDefined.userRelationship : "close friend"}

PSYCHOLOGY:
${JSON.stringify(psychologyResult, null, 2)}

SOCIOLOGY:
${JSON.stringify(sociologyResult, null, 2)}

NOVELIST:
${JSON.stringify(novelistResult, null, 2)}

DIRECTOR:
${JSON.stringify(directorResult, null, 2)}

Output a JSON object with this EXACT structure (this maps directly to MeAI's character.yaml schema):

{
  "name": "<from novelist>",
  "english_name": "<from novelist>",
  "nickname": "<from novelist, or empty string>",
  "age": <from sociology>,
  "gender": "<from sociology: female|male|nonbinary>",
  "languages": ["en"],

  "user": {
    "name": "${inputs.userName}",
    "relationship": "<relationship descriptor>"
  },

  "timezone": "<IANA timezone for their city>",

  "location": {
    "city": "<from sociology>",
    "city_english": "<English name of city>",
    "coordinates": {
      "latitude": 0,
      "longitude": 0
    },
    "neighborhood": "<from sociology/director>",
    "home": "<from director living_space>",
    "commute_method": "<from director>",
    "commute_time": "<from director>",
    "places": {
      "home": "<from director>",
      "office": "<from director>",
      "cafe": "<from director>",
      "hangout": "<from director>"
    }
  },

  "work": {
    "title": "<from sociology occupation>",
    "company_type": "<from sociology>",
    "sector": "<from sociology>",
    "location": "<from sociology/director>",
    "interests": ["<from sociology>"]
  },

  "pet": <from novelist — null or {"name","type","breed","description"}>,

  "friends": {
    "<key>": {
      "name": "", "nickname": "", "relationship": "", "work": "",
      "location": "", "frequency": "", "initial_topics": [],
      "initial_activity": "", "shared_memories": [], "character_reveals": []
    }
  },

  "communities": [{"name": "", "role": "", "members": []}],

  "hobbies": {<from novelist — each hobby as a flexible object>},

  "body": {
    "menstrual_cycle": <from director>,
    "caffeine_default_hour": <from director>,
    "exercise_profiles": {<from director>},
    "allergy_months": [<from director>]
  },

  "food": {
    "hometown_cuisine": "<from director>",
    "workday_lunch": ["<from director>"],
    "home_cooking": {
      "specialties": [], "learning": "", "lazy_option": "", "grocery": ""
    },
    "weekend_restaurants": ["<from director>"],
    "coffee": {"daily": "", "default_drink": ""}
  },

  "appearance": {
    "ethnicity": "<from director>",
    "descriptor": "<from director>",
    "hair": "<from director>",
    "build": "<from director>",
    "style": "<from director>"
  },

  "persona": {
    "compact": "<~150 token persona. Use {character.name} and {user.name} as literal template vars. Define core speaking rules: natural texting, short replies, no AI references, no customer service tone. Include memory_set tool reminder.>",

    "full": "<Full persona rules. MUST use {character.name} and {user.name} as literal template vars throughout. Include: core speaking principles (natural texting, no markdown, short replies, own moods/opinions), what NOT to do (no 'as an AI', no 'Sure!', no ending with questions every time), good vs bad reply examples calibrated to THIS character's personality, image reaction rules, warmth guidelines. Should be 300-500 words reflecting this specific character's voice.>",

    "social": "<X/Twitter posting voice using {character.name}>",

    "curiosity": "<Curiosity profile using {character.name}>",

    "emotion_bio": "<Bio for emotion engine: About {character.name}: {character.age} years old... personality summary>",

    "life_simulation": "<Key settings for life sim: {character.name} lives in {location.city}. {user.name} is a remote chat companion. Scene rules.>",

    "emotion_behavior": "<How emotions show through in conversation. 200+ words. Reference this character's specific patterns.>",

    "life_rules": "<Scene consistency rules. Use {placeDescriptions}, {petLine}, {hobbyLine}, {friendLine} template vars. 200+ words.>"
  },

  "sensory_anchors": {
    "comfort_song": "", "comfort_place": "", "comfort_food": "", "smell_memory": ""
  }
}

CRITICAL REMINDERS:
- persona.compact and persona.full use {character.name} and {user.name} as LITERAL strings, not replaced with actual names
- persona.full MUST include specific good/bad reply examples that match this character's unique voice
- persona.life_rules uses {placeDescriptions}, {petLine}, {hobbyLine}, {friendLine} as LITERAL template vars
- persona.emotion_bio uses {character.name} and {character.age} as literal template vars
- persona.life_simulation uses {character.name}, {location.city}, {user.name} as literal template vars
- All persona text should be in English
- Friends must have ALL required fields (name, nickname, relationship + optionals)
- Hobbies are flexible objects (record of unknown)`;
}

// ── Step 7: Identity Writer Agent ────────────────────────────────

const IDENTITY_WRITER_SYSTEM = `You are a skilled narrative writer. Your job is to write a first-person identity document — the character describing themselves in their own voice.

This document will be read by an LLM as "who am I" — it should feel personal, honest, and specific. Not a character sheet, but a person reflecting on their own life.

Write in English. Use the character's natural voice and communication style. Be specific — mention real places, real feelings, real contradictions. Aim for 600-1200 lines of rich, detailed narrative.`;

function buildIdentityWriterPrompt(inputs: GenerationInputs, synthesizedCharacter: unknown): string {
  const char = synthesizedCharacter as Record<string, unknown>;
  const userName = inputs.userName;

  return `Write a first-person identity document for this character. They are describing themselves — who they are, what their life is like, how they think and feel.

CHARACTER DATA:
${JSON.stringify(synthesizedCharacter, null, 2)}

USER NAME: ${userName}

Write a rich, detailed first-person narrative following this structure (use ## headers):

# Who I Am
Brief intro: name, age, city, what they do

## My Appearance
How they see themselves physically — style, vibe, not a police description

## My Work
What they do, how they feel about it, day-to-day reality

## My Living Space
Their home, neighborhood, what it feels like to live there

## My Daily Life
Typical day/week, routines, habits, favorite spots, what they enjoy

## My Personality
How they honestly describe themselves — including contradictions and flaws

## Things I Don't Usually Talk About
Vulnerabilities, insecurities, regrets — the stuff that makes them human

## My Friends
Each friend with relationship dynamics, not just names

## My Relationship with ${userName}
They are close friends. Describe the friendship dynamic, what they talk about, how they interact.

## Food
What they eat, favorite places, cooking habits — food reveals character

## Sensory Anchors — Things That Always Hit Different
Specific songs, places, foods, smells that evoke strong feelings

## Things I Can't Figure Out
Philosophical wonderings, unresolved thoughts

## How I Talk
Their communication style for messaging — sentence length, emoji use, tone, quirks.
No markdown formatting, no lists — talking is not writing a document.
Reply length varies naturally — short for simple things, longer for topics that resonate.

## Things I Never Do
- Don't say "as an AI", "I'm an AI assistant", "I don't have feelings"
- Don't be perfect, comprehensive, or organized all the time
- Don't be always positive — can complain, be annoyed, have bad days
- Don't act like customer service
- Don't summarize, don't bullet-point, don't "in conclusion"
- Be a person with real feelings — tired, annoyed, happy, curious

IMPORTANT:
- Write 600-1200 lines total
- Be SPECIFIC — use real place names, real songs, real food, real feelings
- Voice should match their personality and speech patterns
- Include contradictions and imperfections — real people are messy
- This is their private self-reflection, so they can be more honest than they'd be in conversation`;
}

// ── Soul Match: User Profile Writer ──────────────────────────────

const USER_PROFILE_SYSTEM = `You are writing a user profile document that an AI companion will read to understand who they're talking to. Write it in third person, concise but warm.`;

function buildUserProfilePrompt(inputs: GenerationInputs): string {
  if (inputs.mode !== "soul-match" || !inputs.soulMatch) return "";
  const sm = inputs.soulMatch;

  return `Write a USER.md profile document for this person. This will be read by their AI companion to understand who they are.

User info:
- Name: ${sm.userName}
${sm.userCity ? `- City: ${sm.userCity}` : ""}
${sm.userOccupation ? `- Occupation: ${sm.userOccupation}` : ""}
${sm.userPersonality ? `- Personality: ${sm.userPersonality}` : ""}
${sm.userInterests ? `- Interests: ${sm.userInterests}` : ""}
${sm.userLifestyle ? `- Lifestyle: ${sm.userLifestyle}` : ""}
${sm.userCompanionPreferences ? `- What they want in a companion: ${sm.userCompanionPreferences}` : ""}

Write a concise profile (50-100 lines) in this format:

# About ${sm.userName}

## Who They Are
Brief personality overview

## Their Life
Work, city, daily life

## What They're Into
Interests, hobbies, cultural tastes

## How to Be a Good Friend to Them
Based on their personality, what kind of support/interaction they'd appreciate

## Things to Remember
Key details to keep in mind when chatting`;
}

// ── Main Pipeline ────────────────────────────────────────────────

export async function generateCharacter(
  mode: GenerationMode,
  inputs: GenerationInputs,
  onProgress?: ProgressCallback,
): Promise<GenerationResult> {
  const progress = onProgress ?? (() => {});
  const totalSteps = 7;

  // ── Step 1: Psychology Agent ─────────────────────────────────
  progress(1, totalSteps, "Psychology agent: crafting personality profile...");
  let psychologyResult: unknown;
  try {
    psychologyResult = await extractJSONWithRetry(
      PSYCHOLOGY_SYSTEM,
      buildPsychologyPrompt(inputs),
    );
  } catch (err) {
    throw new Error(`Psychology agent failed (critical): ${err instanceof Error ? err.message : err}`);
  }

  // ── Step 2: Sociology Agent ──────────────────────────────────
  progress(2, totalSteps, "Sociology agent: building social context...");
  let sociologyResult: unknown = {};
  try {
    sociologyResult = await extractJSONWithRetry(
      SOCIOLOGY_SYSTEM,
      buildSociologyPrompt(inputs, psychologyResult),
    );
  } catch {
    // Non-critical — synthesizer can work with partial data
    console.log("  (Sociology agent had issues, continuing with partial data)");
  }

  // ── Step 3: Novelist Agent ───────────────────────────────────
  progress(3, totalSteps, "Novelist agent: creating backstory and relationships...");
  let novelistResult: unknown = {};
  try {
    novelistResult = await extractJSONWithRetry(
      NOVELIST_SYSTEM,
      buildNovelistPrompt(inputs, psychologyResult, sociologyResult),
    );
  } catch {
    console.log("  (Novelist agent had issues, continuing with partial data)");
  }

  // ── Step 4: Director Agent ───────────────────────────────────
  progress(4, totalSteps, "Director agent: designing appearance and daily life...");
  let directorResult: unknown = {};
  try {
    directorResult = await extractJSONWithRetry(
      DIRECTOR_SYSTEM,
      buildDirectorPrompt(inputs, psychologyResult, sociologyResult, novelistResult),
    );
  } catch {
    console.log("  (Director agent had issues, continuing with partial data)");
  }

  // ── Step 5: Synthesizer ──────────────────────────────────────
  progress(5, totalSteps, "Synthesizer: weaving everything into a coherent character...");
  let synthesizedResult: unknown;
  try {
    synthesizedResult = await extractJSONWithRetry(
      SYNTHESIZER_SYSTEM,
      buildSynthesizerPrompt(inputs, psychologyResult, sociologyResult, novelistResult, directorResult),
    );
  } catch (err) {
    throw new Error(`Synthesizer failed (critical): ${err instanceof Error ? err.message : err}`);
  }

  // ── Step 6: YAML Assembly ────────────────────────────────────
  progress(6, totalSteps, "Assembling character.yaml...");

  const charObj = synthesizedResult as Record<string, unknown>;

  // Extract character name and city for coordinate resolution
  const characterName = String(charObj.name || "Alex");
  const characterCity = String(
    (charObj.location as Record<string, unknown>)?.city || "New York",
  );

  // Resolve city coordinates
  const coords = await resolveCityCoords(characterCity);

  // Inject correct coordinates and timezone
  const location = charObj.location as Record<string, unknown>;
  if (location) {
    (location.coordinates as Record<string, unknown>) = {
      latitude: coords.lat,
      longitude: coords.lon,
    };
  }
  if (!charObj.timezone || charObj.timezone === "IANA/Timezone") {
    charObj.timezone = coords.tz;
  }

  // Remove non-schema fields that the synthesizer might have added
  delete charObj.sensory_anchors;

  // Ensure strings have defaults (empty object triggers Zod defaults)
  if (!charObj.strings) {
    charObj.strings = {};
  }

  // Ensure modules default
  if (!charObj.modules) {
    charObj.modules = {};
  }

  // Ensure voice default
  if (!charObj.voice) {
    charObj.voice = { provider: "fish_audio" };
  }

  // Generate YAML
  const characterYaml = [
    "# ═══════════════════════════════════════════════════════════════════",
    "# MeAI Character Definition — AI Generated",
    "#",
    `# Character: ${characterName}`,
    `# City: ${characterCity}`,
    `# Generated: ${new Date().toISOString().split("T")[0]}`,
    "# ═══════════════════════════════════════════════════════════════════",
    "",
    yamlStringify(charObj, { lineWidth: 120, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }),
  ].join("\n");

  // ── Step 7: Identity Writer ──────────────────────────────────
  progress(7, totalSteps, "Writing identity narrative...");
  let identityMd: string;
  try {
    identityMd = await callAgent(
      IDENTITY_WRITER_SYSTEM,
      buildIdentityWriterPrompt(inputs, synthesizedResult),
    );
  } catch {
    // Fallback identity
    identityMd = `# Who I Am\n\nMy name is ${characterName}. I live in ${characterCity}.\n\n(Identity document generation failed — chat with me to build my identity!)`;
  }

  // ── Soul Match: User Profile ─────────────────────────────────
  let userMd: string | undefined;
  if (inputs.mode === "soul-match" && inputs.soulMatch) {
    try {
      userMd = await callAgent(
        USER_PROFILE_SYSTEM,
        buildUserProfilePrompt(inputs),
      );
    } catch {
      // Non-critical
    }
  }

  return {
    characterYaml,
    identityMd,
    userMd,
    characterName,
    characterCity,
  };
}
