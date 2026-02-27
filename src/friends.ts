/**
 * Friend relationship tracker — makes the character's social circle real.
 *
 * Tracks interactions with her SF friends so they become
 * real people with real recent interactions, not just names.
 *
 * Tracks friend relationships, interactions, and group dynamics
 *
 * State persists in friend-state.json and feeds into:
 * 1. world.ts — schedule generation probability-arranges meetups
 * 2. emotion.ts — social events affect mood
 * 3. system prompt — natural references to recent friend activities
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { getCharacter, s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface FriendProfile {
  name: string;
  nickname?: string;        // nickname
  relationship: string;     // e.g. "college best friend" | "work colleague" | "pottery class friend"
  work: string;             // "Google PM" | "portfolio manager"
  location: string;         // e.g. "Mountain View" | "New York"
  frequency: string;        // e.g. "weekly" | "once or twice a month"
  lastSeen: string;         // ISO date
  lastActivity: string;     // e.g. "had brunch together"
  nextPlanned: string | null;// e.g. "pottery class together next Saturday"
  recentTopics: string[];   // recent conversation topics
  tieStrength: number;        // 0-1, decays without interaction
  reciprocityBalance: number; // positive = she initiates more, negative = they do
  interactions: Array<{ date: string; type: string; initiated: boolean }>;
  emotionalValence: number;   // -5 to +5, overall feeling about this friendship
  // 6.3: Life events for social comparison
  lifeEvents?: LifeEvent[];
  // 6.4: Friend maintenance labor
  driftAlert?: { active: boolean; daysSinceContact: number; guiltLevel: number };
  pendingFollowUps?: string[];
  // 10.4: Textured friendships
  sharedMemories?: SharedMemory[];
  characterReveals?: string[];
}

/** 6.3: Life event for social comparison */
export interface LifeEvent {
  date: string;
  event: string;
  category: "career" | "relationship" | "milestone";
}

/** 10.4: Shared memory with a friend */
export interface SharedMemory {
  date: string;
  type: "conflict" | "support" | "vulnerability" | "fun";
  description: string;
  resolved?: boolean;
}

export interface FriendState {
  friends: Record<string, FriendProfile>;
  communities: CommunityTie[];
  lastUpdated: string;
}

export interface SocialContext {
  recentFriendUpdates: string[];  // e.g. "friend recently considering a job change"
  fomoScore: number;              // 0-10, fear of missing out
  gratitudeItems: string[];       // things to be grateful for socially
  comparisonVulnerability: number; // 6.3: 0-10, social comparison pressure
  driftingFriends: string[];      // 6.4: friends who haven't been contacted
}

export interface CommunityTie {
  name: string;            // e.g. "pottery class", "work team", "running group"
  role: string;            // e.g. "student", "analyst", "occasional participant"
  belonging: number;       // 0-1
  lastEngaged: string;     // ISO date
  members: string[];       // notable members
}

// ── Module State ─────────────────────────────────────────────────────

let dataPath = "";

export function initFriends(statePath: string): void {
  dataPath = statePath;
}

// ── Persistence ──────────────────────────────────────────────────────

function getStatePath(): string {
  return path.join(dataPath, "friend-state.json");
}

export function loadFriendState(): FriendState {
  if (!dataPath) return defaultFriendState();
  const p = getStatePath();
  if (!fs.existsSync(p)) return defaultFriendState();
  return readJsonSafe<FriendState>(p, defaultFriendState());
}

export function saveFriendState(state: FriendState): void {
  if (!dataPath) return;
  state.lastUpdated = pstDateStr();
  writeJsonAtomic(getStatePath(), state);
}

function defaultFriendState(): FriendState {
  const today = pstDateStr();
  const char = getCharacter();

  // Seed friends from character.yaml
  const friends: Record<string, FriendProfile> = {};
  for (const [key, f] of Object.entries(char.friends)) {
    friends[key] = {
      name: f.name,
      nickname: f.nickname,
      relationship: f.relationship,
      work: f.work ?? "",
      location: f.location ?? "",
      frequency: f.frequency ?? "",
      lastSeen: today,
      lastActivity: f.initial_activity ?? "",
      nextPlanned: null,
      recentTopics: f.initial_topics,
      tieStrength: 0.7,
      reciprocityBalance: 0,
      interactions: [],
      emotionalValence: 3,
      lifeEvents: [],
      sharedMemories: f.shared_memories.map((desc) => ({
        date: today,
        type: "fun" as const,
        description: desc,
      })),
      characterReveals: f.character_reveals,
    };
  }

  // Seed communities from character.yaml
  const communities = char.communities.map((c) => ({
    name: c.name,
    role: c.role ?? "",
    belonging: 0.6,
    lastEngaged: today,
    members: c.members,
  }));

  return {
    friends,
    communities,
    lastUpdated: today,
  };
}

// ── Updates ──────────────────────────────────────────────────────────

/** Record seeing a friend */
export function recordFriendMeeting(
  friendKey: string,
  activity: string,
  topics?: string[],
): void {
  const state = loadFriendState();
  const friend = state.friends[friendKey];
  if (!friend) return;

  friend.lastSeen = pstDateStr();
  friend.lastActivity = activity;
  if (topics && topics.length > 0) {
    friend.recentTopics = topics.slice(0, 3);
  }
  friend.nextPlanned = null; // fulfilled

  saveFriendState(state);
}

/** Set next planned meetup */
export function planFriendMeeting(friendKey: string, plan: string): void {
  const state = loadFriendState();
  const friend = state.friends[friendKey];
  if (!friend) return;

  friend.nextPlanned = plan;
  saveFriendState(state);
}

// ── Tie-Strength & Social Context ────────────────────────────────────

/**
 * Daily tie-strength decay and interaction boosts.
 * Call once per day (from heartbeat or world.ts).
 */
export function updateTieStrength(): void {
  const state = loadFriendState();
  const today = pstDateStr();

  for (const friend of Object.values(state.friends)) {
    const daysSince = daysBetween(friend.lastSeen, today);
    const decayRate = 0.01; // lose 1% per day without contact
    friend.tieStrength = Math.max(0, (friend.tieStrength ?? 0.5) - daysSince * decayRate);

    // Recent interactions boost
    const recentInteractions = (friend.interactions ?? []).filter(i => {
      return daysBetween(i.date, today) <= 7;
    });
    friend.tieStrength = Math.min(1, (friend.tieStrength ?? 0.5) + recentInteractions.length * 0.05);

    // 6.4: Friend drift detection — 14+ days no contact triggers drift alert
    if (daysSince >= 14) {
      const guiltLevel = Math.min(1, (daysSince - 14) * 0.05);
      friend.driftAlert = { active: true, daysSinceContact: daysSince, guiltLevel };
      // Generate pending follow-ups from recent topics if empty
      if (!friend.pendingFollowUps || friend.pendingFollowUps.length === 0) {
        if (friend.recentTopics.length > 0) {
          friend.pendingFollowUps = [`Ask ${friend.name} about "${friend.recentTopics[0]}"`];
        }
      }
    } else {
      // Clear drift alert on recent contact
      if (friend.driftAlert?.active) {
        friend.driftAlert = { active: false, daysSinceContact: daysSince, guiltLevel: 0 };
        friend.pendingFollowUps = [];
      }
    }
  }

  // Community belonging decay
  for (const community of (state.communities ?? [])) {
    const daysSince = daysBetween(community.lastEngaged, today);
    if (daysSince > 7) {
      community.belonging = Math.max(0, community.belonging - 0.02);
    }
  }

  saveFriendState(state);
}

/** Record an interaction with a friend */
export function recordInteraction(
  friendKey: string,
  type: string,
  initiated: boolean,
): void {
  const state = loadFriendState();
  const friend = state.friends[friendKey];
  if (!friend) return;

  const today = pstDateStr();
  if (!friend.interactions) friend.interactions = [];
  friend.interactions.push({ date: today, type, initiated });
  // Keep last 20 interactions
  if (friend.interactions.length > 20) {
    friend.interactions = friend.interactions.slice(-20);
  }

  // Update reciprocity
  friend.reciprocityBalance = (friend.reciprocityBalance ?? 0) + (initiated ? 0.1 : -0.1);
  friend.reciprocityBalance = Math.max(-2, Math.min(2, friend.reciprocityBalance ?? 0));

  // Boost tie strength
  friend.tieStrength = Math.min(1, (friend.tieStrength ?? 0.5) + 0.1);

  saveFriendState(state);
}

/** Get social context for emotion generation */
export function getSocialContext(): SocialContext {
  const state = loadFriendState();
  const today = pstDateStr();
  const updates: string[] = [];
  let fomoScore = 0;
  const gratitude: string[] = [];
  let comparisonVulnerability = 0;
  const driftingFriends: string[] = [];

  for (const [, friend] of Object.entries(state.friends)) {
    // Recent activities become updates
    const daysSince = daysBetween(friend.lastSeen, today);
    if (daysSince <= 3 && friend.lastActivity) {
      updates.push(`${friend.name}: ${friend.lastActivity}`);
    }
    // FOMO from not seeing friends
    if (daysSince > 14) fomoScore += 2;
    else if (daysSince > 7) fomoScore += 1;
    // Gratitude from strong ties
    if ((friend.tieStrength ?? 0) > 0.7) {
      gratitude.push(`friendship with ${friend.name}`);
    }

    // 6.3: Social comparison — recent friend life events create vulnerability
    if (friend.lifeEvents) {
      for (const event of friend.lifeEvents) {
        const eventAge = daysBetween(event.date, today);
        if (eventAge > 30) continue; // only recent events matter
        const weight: Record<string, number> = { career: 2, relationship: 3, milestone: 1 };
        comparisonVulnerability += weight[event.category] ?? 1;
      }
    }

    // 6.4: Drift alert surfacing
    if (friend.driftAlert?.active) {
      driftingFriends.push(`${friend.name} (${friend.driftAlert.daysSinceContact} days)`);
    }
  }

  return {
    recentFriendUpdates: updates,
    fomoScore: Math.min(10, fomoScore),
    gratitudeItems: gratitude,
    comparisonVulnerability: Math.min(10, comparisonVulnerability),
    driftingFriends,
  };
}

// ── Formatting ───────────────────────────────────────────────────────

/** Format friend state for schedule generation context */
export function formatFriendContext(): string {
  const state = loadFriendState();
  const today = pstDateStr();
  const lines: string[] = [];

  for (const [, friend] of Object.entries(state.friends)) {
    const daysSince = daysBetween(friend.lastSeen, today);
    const planned = friend.nextPlanned ? `, plan: ${friend.nextPlanned}` : "";
    const lastTopic = friend.recentTopics.length > 0 ? ` (last talked about ${friend.recentTopics[0]})` : "";

    lines.push(
      `${friend.name} (${friend.relationship}): ${daysSince} days since last seen, ` +
      `${friend.lastActivity}${lastTopic}${planned}`
    );
  }

  return lines.join("\n");
}

/** Format for system prompt — brief summary of recent social life */
export function formatSocialSummary(): string {
  const state = loadFriendState();
  const today = pstDateStr();
  const recent: string[] = [];

  for (const [, friend] of Object.entries(state.friends)) {
    const daysSince = daysBetween(friend.lastSeen, today);
    if (daysSince <= 3) {
      const timeLabel = daysSince === 0 ? s().time.today : s().time.days_ago.replace("{n}", String(daysSince));
      recent.push(`${timeLabel} ${friend.lastActivity} with ${friend.name}`);
    }
  }

  const parts: string[] = [];
  if (recent.length > 0) parts.push(s().conversation.signal_recent_social.replace("{updates}", recent.join("; ")));

  // 6.4: Surface drifting friends
  const drifting = Object.values(state.friends).filter(f => f.driftAlert?.active);
  if (drifting.length > 0) {
    parts.push(s().conversation.signal_drifting.replace("{friends}", drifting.map(f => `${f.name} (${f.driftAlert!.daysSinceContact} days)`).join(", ")));
  }

  // 10.4: 20% chance surface a character-revealing memory
  if (Math.random() < 0.2) {
    const friendsWithMemories = Object.values(state.friends).filter(
      f => (f.sharedMemories?.length ?? 0) > 0 || (f.characterReveals?.length ?? 0) > 0,
    );
    if (friendsWithMemories.length > 0) {
      const pick = friendsWithMemories[Math.floor(Math.random() * friendsWithMemories.length)];
      if (pick.characterReveals && pick.characterReveals.length > 0) {
        const reveal = pick.characterReveals[Math.floor(Math.random() * pick.characterReveals.length)];
        parts.push(`About ${pick.name}: ${reveal}`);
      } else if (pick.sharedMemories && pick.sharedMemories.length > 0) {
        const mem = pick.sharedMemories[Math.floor(Math.random() * pick.sharedMemories.length)];
        parts.push(`Remembered something with ${pick.name}: ${mem.description}`);
      }
    }
  }

  return parts.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

function daysBetween(dateStr1: string, dateStr2: string): number {
  try {
    const d1 = new Date(dateStr1);
    const d2 = new Date(dateStr2);
    return Math.abs(Math.floor((d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}
