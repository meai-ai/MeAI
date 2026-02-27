# Creating Your Own Character

This guide walks you through customizing MeAI with your own character. You'll edit two files:

1. **`data/character.yaml`** — Structured data that drives code behavior (name, location, timezone, friends, hobbies, body config, persona prompts)
2. **`data/memory/IDENTITY.md`** — Free-form narrative identity document (the LLM reads this as "who am I")

## Quick Start

```bash
# Option A: Start from the full example (recommended)
cp data/character.example.yaml data/character.yaml

# Option B: Start from the minimal template
cp data/character.minimal.yaml data/character.yaml
```

Edit `data/character.yaml` with your character's details, then run `npm start`.

## character.yaml Reference

### Required Fields

```yaml
name: Alex              # Character's display name
user:
  name: Sam             # Who the character is talking to
timezone: America/New_York
location:
  city: New York
  coordinates:
    latitude: 40.7128
    longitude: -74.0060
persona:
  compact: |            # ~150 tokens, used for simple exchanges
    You are Alex, Sam's close friend. Chat naturally...
  full: |               # Full persona rules for main conversations
    You are Alex, Sam's close friend...
```

### Identity

```yaml
name: Alex                   # Primary name
english_name: Alex           # English name (used in some prompts)
nickname: Alex               # Short form
age: 28
gender: female               # female | male | nonbinary
languages:
  - en
  - zh-CN
```

`gender` affects the body simulation — set `body.menstrual_cycle: true` only for characters who should have a menstrual cycle. It defaults to `false`.

### User

```yaml
user:
  name: Sam                  # User's name
  relationship: close friend # How the character sees the user
  location: Portland         # User's city (for timing/context)
  work: software engineer    # User's job (for conversation)
  family:                    # Optional
    - name: Maya
      relation: daughter
```

### Location

```yaml
timezone: America/New_York

location:
  city: New York
  city_english: New York     # Optional, for weather API
  coordinates:
    latitude: 40.7128
    longitude: -74.0060
  neighborhood: Brooklyn
  home: a cozy apartment in Brooklyn
  commute_method: subway
  commute_time: 30 minutes
  places:                    # Named locations for schedule/context
    home: a cozy apartment in Brooklyn with a view of the park
    coffee shop: Blue Bottle on Bergen St, always gets a pour-over
    office: WeWork in DUMBO, third floor by the window
    gym: small CrossFit box on Atlantic Ave
```

The `places` map is used by the schedule generator and context system. The key is a short label; the value is a vivid description that gives the LLM sensory details.

### Work (Optional)

```yaml
work:
  title: game designer
  company_type: indie studio
  sector: gaming
  location: DUMBO
  interests:
    - procedural generation
    - narrative design
    - pixel art
```

### Pet (Optional)

```yaml
pet:
  name: Mochi
  type: dog
  breed: shiba inu
  description: dramatic, refuses to walk on wet grass
```

Set to `null` or omit entirely for no pet:

```yaml
pet: null
```

### Friends

```yaml
friends:
  jordan:
    name: Jordan
    nickname: J
    relationship: college roommate
    work: freelance photographer
    location: Brooklyn
    frequency: twice a week
    initial_topics:
      - planning a gallery show
    initial_activity: coffee at their usual spot
    shared_memories:
      - got lost in Tokyo together during study abroad
    character_reveals:
      - they bring out my adventurous side

communities:
  - name: CrossFit box
    role: regular
    members:
      - Jordan
      - coach Mike
```

Friends are seeded into `friend-state.json` on first run. After that, the runtime state is authoritative — the character builds real relationships through conversations and proactive interactions.

### Hobbies

```yaml
hobbies:
  pottery:
    label: pottery
    initial_sessions: 12
    initial_project: making a set of cups
    initial_status: glazing this weekend
    milestones:
      - first bowl that didn't collapse
  running:
    label: running
    exercise_type: running          # Links to body.exercise_profiles
    usual_route: along the waterfront
    usual_pace: about 6 min/km
  cooking:
    label: cooking
    specialties:
      - pasta carbonara
      - miso soup
  vibe_coding:
    label: vibe coding
    initial_project: personal website
    recent_completions:
      - Mochi walk tracker
      - recipe manager
```

Hobbies are flexible — you can add any keys you want. The `exercise_type` key links to body simulation (see below). The `vibe_coding` hobby has special handling for the activities engine.

### Body Configuration

```yaml
body:
  menstrual_cycle: false       # Set true + provide details if applicable
  cycle_length: 28             # Only used when menstrual_cycle: true
  last_period_start: "2026-02-15"  # Only used when menstrual_cycle: true
  caffeine_default_hour: 8     # Hour of first coffee (24h format)
  exercise_profiles:
    running:
      fatigue_cost: 2.5
      recovery_hours: 1.5
      peak_benefit: -2.0       # Negative = reduces fatigue post-recovery
      mood_boost: 1.5
    yoga:
      fatigue_cost: 0.5
      recovery_hours: 0.5
      peak_benefit: -1.5
      mood_boost: 2.0
  allergy_months: [3, 4, 5]   # Months with allergy risk (1-12)
  allergy_note: spring pollen season
```

### Food & Dining (Optional)

```yaml
food:
  hometown_cuisine: mom's lasagna
  workday_lunch:
    - salad from the place downstairs
    - ramen shop on Smith St
  home_cooking:
    specialties:
      - pasta carbonara
      - stir-fry
    learning: trying to perfect sourdough
    lazy_option: frozen pizza
    grocery: Trader Joe's
  weekend_restaurants:
    - that new Thai place everyone's talking about
    - classic diner on 5th
  coffee:
    daily: pour-over from Blue Bottle
    default_drink: black coffee
```

### Appearance (for Image Generation)

```yaml
appearance:
  ethnicity: East Asian
  descriptor: young East Asian woman    # Used in image gen prompts
  hair: short black bob
  build: athletic, about 5'7"
  style: minimalist, lots of black and white
  sticker_activities:
    dog_walk: walking a shiba inu
    cooking: cooking at a kitchen counter
```

### Voice (Optional)

```yaml
voice:
  provider: fish_audio
  # voice_id goes in config.json (fishAudioVoiceId) since it's account-specific
```

### Persona Prompts

This is the most important section — it defines your character's voice and personality.

```yaml
persona:
  compact: |
    # ~150 tokens. Used for simple exchanges.
    You are Alex, Sam's close friend. Chat naturally...

  full: |
    # Full persona rules for the main conversation.
    # This is typically 200-500 lines of detailed instructions
    # covering speech patterns, example dialogues, personality, etc.
    You are Alex, Sam's close friend...

  social: |
    # Voice for X/Twitter posts
    You are Alex, a game designer in New York...

  curiosity: |
    # Interest profile for web exploration
    You are Alex's curiosity. She's a game designer who loves...

  emotion_bio: |
    # Short bio for the emotion engine
    About Alex: 28, game designer in New York, has a shiba inu named Mochi...

  life_simulation: |
    # Rules for the daily schedule simulator
    Key settings:
    - Alex lives alone in Brooklyn with Mochi...

  moments: You are Alex
    # Name prefix for social media posts

  seasonal_mood:
    fall: "New York in fall feels cinematic, makes me nostalgic"
    winter: "the cold makes me want to hibernate with Mochi"
```

The `full` persona is the most important — it shapes every conversation. Study `character.example.yaml` for a detailed example of how to write speech patterns, example dialogues, and personality guidelines.

#### Advanced Persona Keys

Beyond the core persona prompts above, MeAI uses many additional `persona.*` keys for specific LLM-powered subsystems. Each is optional — when omitted, the system uses built-in English defaults.

| Key | What it controls |
|-----|------------------|
| `emotion_behavior` | How emotions manifest in conversation (mood leaking, voice messages) |
| `life_rules` | Scene consistency rules (body/time/space awareness) |
| `capabilities` | Full tool usage instructions shown in system prompt |
| `capabilities_minimal` | Short capabilities for compact context mode |
| `schedule_generator` | System prompt for daily schedule LLM generation |
| `selfie_decision` | When to send selfies/photos proactively |
| `selfie_prompt_gen` | How to generate image prompts |
| `moments_emotion` | Caption generation for emotion-triggered posts |
| `moments_selfie` | Caption for selfie posts |
| `moments_activity` | Caption for activity posts |
| `moments_discovery` | Caption for discovery posts |
| `moments_thought` | Caption for thought posts |
| `knowledge_digest` | Knowledge digestion and synthesis prompt |
| `timeline_extraction` | Extract timeline events from conversations |
| `activity_impulse` | "Should I do something?" activity check |
| `activity_choice` | "What do I want to do?" activity picker |
| `vibe_coding_idea` | Generate vibe coding project ideas |
| `vibe_coding_reflect` | Reflect on completed projects |
| `deep_read_reflect` | Reflect on reading |
| `learn_topic` | Choose learning topics |
| `learn_instructions` | Learning session instructions |
| `learn_reflect` | Reflect on learning |
| `compose_concept` | Music composition concept generation |
| `compose_reflect` | Reflect on compositions |
| `proactive_outreach` | Proactive messaging decision prompt |
| `proactive_context` | Context building for proactive messages |
| `emotion_generator` | Emotion state generation prompt |
| `heartbeat_decision` | Heartbeat action decision prompt |
| `curiosity_query` | Web exploration query generation |
| `curiosity_triage` | Search result evaluation |
| `curiosity_synthesis` | Discovery summarization |
| `social_post` | X/Twitter posting prompt |
| `prompt_optimizer` | Auto-optimization rule generation |

These prompts support `{character.name}`, `{user.name}`, `{pet.name}`, `{location.city}` and other template variables that are automatically substituted. See `character.example.yaml` for complete Chinese examples.

### Strings (Localization)

All UI labels, section headers, time formats, weather codes, body state descriptions, and pattern-matching keywords are configurable via the `strings` section. **English defaults are built into the code** — you only need this section to override for another language.

```yaml
strings:
  headers:
    about_self: "About Me"
    inner_state: "My Current Inner State"
    # ... 30+ header labels
  time:
    day_names: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    seasons:
      spring: "spring"
      summer: "summer"
      fall: "fall"
      winter: "winter"
    minutes_ago: "{n}min ago"
    hours_ago: "{n}h ago"
  weather_codes:
    "0": "clear"
    "61": "light rain"
    # ... WMO weather codes
  body:
    energy: "Energy"
    hunger: "Hunger"
    cramps: "mild cramps"
    # ... 50+ body state strings
  schedule:
    sleeping: "sleeping"
    morning_routine: "morning routine"
    # ... schedule display labels
  notifications:
    price_above: "{name} ({ticker}) rose to ${price}"
    # ... notification templates
  conversation:
    tone_normal: "normal"
    tone_low: "a bit low"
    # ... conversation mode labels
  patterns:
    selfie_request: ["selfie", "photo", "picture"]
    emotional_peak: ["so happy", "crying", "amazing"]
    exercise_keywords: ["running", "yoga", "tennis", "gym"]
    # ... keyword arrays for pattern matching
```

The `strings` section is organized into nested groups: `headers`, `time`, `weather_codes`, `daylight`, `body`, `schedule`, `notifications`, `conversation`, and `patterns`. See `character.example.yaml` for a complete Chinese override example.

## IDENTITY.md

`data/memory/IDENTITY.md` is a free-form narrative document that the LLM reads as "who am I." While `character.yaml` provides structured data for code, IDENTITY.md gives the LLM a rich, natural-language understanding of the character.

Example:

```markdown
# Alex

I'm Alex, 28. I live in Brooklyn with my dramatic shiba inu Mochi.
I design games for a living — mostly indie narrative stuff.

I moved to New York three years ago from Portland...
```

Write it in first person, as the character would describe themselves. Include personality, backstory, quirks, relationships, and anything that makes the character feel real.

## USER.md

`data/memory/USER.md` describes the person the character is talking to:

```markdown
# Sam

Sam is a software engineer in Portland. We've been friends for years...
```

## Tips

- **Start minimal.** Use `character.minimal.yaml` and add details over time. The system works with just the required fields.
- **Persona is everything.** The `persona.full` prompt shapes 90% of the character's behavior. Spend time on it.
- **Use examples.** In your persona prompt, include "good reply" vs "bad reply" examples. This calibrates the LLM's output better than abstract rules.
- **Run and iterate.** Start the bot, chat with it, and refine the persona based on what feels off.
- **The character learns.** Through the memory system, the character accumulates experiences over time. Initial state in character.yaml is just the starting point.
