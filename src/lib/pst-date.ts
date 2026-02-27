/**
 * Character-timezone date utilities — single source of truth for "today" in the character's timezone.
 *
 * Problem: `new Date().toISOString().slice(0, 10)` returns UTC date,
 * which is wrong after 4pm PST (midnight UTC = next day).
 *
 * Solution: Always convert to character timezone before extracting date components.
 *
 * The timezone is read from character.yaml via getCharacter().
 * Before initCharacter() is called, falls back to "America/Los_Angeles".
 */

import { getCharacter } from "../character.js";

/** Get the character's timezone. Safe to call before initCharacter() (falls back to LA). */
export function getUserTZ(): string {
  try {
    return getCharacter().timezone;
  } catch {
    return "America/Los_Angeles";
  }
}

/** @deprecated Use getUserTZ() — kept for import compatibility */
export const USER_TZ = "America/Los_Angeles";

/** Get current time in the character's timezone as a Date object. */
export function pstNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: getUserTZ() }));
}

/** Get today's date string in the character's timezone: "YYYY-MM-DD". */
export function pstDateStr(date?: Date): string {
  const tz = getUserTZ();
  const d = date ? new Date(date.toLocaleString("en-US", { timeZone: tz })) : pstNow();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Get today's date string from a timestamp (ms) in the character's timezone. */
export function pstDateStrFromTs(timestampMs: number): string {
  return pstDateStr(new Date(timestampMs));
}
