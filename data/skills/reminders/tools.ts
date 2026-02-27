/**
 * Reminders skill — schedule timed reminders that fire via Telegram.
 *
 * Persistence: reminders stored in JSON file, survive restarts.
 * Delivery: uses Telegram Bot API directly via fetch().
 * Past-due: checked and fired whenever any reminder tool is called.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Reminder {
  id: string;
  message: string;
  fire_at: number;        // unix ms
  created_at: number;     // unix ms
  fired: boolean;
  recurring?: string;     // e.g. "daily", "weekly", "monthly"
}

interface ReminderStore {
  reminders: Reminder[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

function getStorePath(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'reminders');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'reminders.json');
}

function loadStore(config: any): ReminderStore {
  const path = getStorePath(config);
  if (!existsSync(path)) return { reminders: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { reminders: [] };
  }
}

function saveStore(config: any, store: ReminderStore): void {
  writeFileSync(getStorePath(config), JSON.stringify(store, null, 2));
}

// ── Telegram delivery ───────────────────────────────────────────────────────

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch {
    // Best-effort delivery
  }
}

// ── Fire due reminders ──────────────────────────────────────────────────────

async function fireDueReminders(config: any): Promise<string[]> {
  const store = loadStore(config);
  const now = Date.now();
  const fired: string[] = [];

  for (const r of store.reminders) {
    if (!r.fired && r.fire_at <= now) {
      r.fired = true;
      fired.push(r.message);

      // Send via Telegram
      if (config?.telegramBotToken && config?.allowedChatId) {
        await sendTelegramMessage(
          config.telegramBotToken,
          config.allowedChatId,
          `⏰ *Reminder*\n\n${r.message}`,
        );
      }

      // Handle recurring: schedule next occurrence
      if (r.recurring) {
        const nextFireAt = computeNextOccurrence(r.fire_at, r.recurring);
        if (nextFireAt) {
          store.reminders.push({
            id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            message: r.message,
            fire_at: nextFireAt,
            created_at: now,
            fired: false,
            recurring: r.recurring,
          });
        }
      }
    }
  }

  if (fired.length > 0) {
    saveStore(config, store);
  }
  return fired;
}

function computeNextOccurrence(lastFire: number, recurring: string): number | null {
  const d = new Date(lastFire);
  switch (recurring) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      return d.getTime();
    case 'weekly':
      d.setDate(d.getDate() + 7);
      return d.getTime();
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      return d.getTime();
    default:
      return null;
  }
}

// ── Schedule in-process timer for immediate delivery ────────────────────────

function scheduleTimer(config: any, reminder: Reminder): void {
  const delay = reminder.fire_at - Date.now();
  if (delay <= 0) return; // Will be caught by fireDueReminders

  // Cap at 24 hours to avoid Node.js setTimeout overflow issues
  const maxDelay = 24 * 60 * 60 * 1000;
  if (delay > maxDelay) return; // Will be caught on next interaction

  setTimeout(async () => {
    const store = loadStore(config);
    const r = store.reminders.find(x => x.id === reminder.id);
    if (r && !r.fired) {
      r.fired = true;

      if (config?.telegramBotToken && config?.allowedChatId) {
        await sendTelegramMessage(
          config.telegramBotToken,
          config.allowedChatId,
          `⏰ *Reminder*\n\n${r.message}`,
        );
      }

      if (r.recurring) {
        const nextFireAt = computeNextOccurrence(r.fire_at, r.recurring);
        if (nextFireAt) {
          const next: Reminder = {
            id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            message: r.message,
            fire_at: nextFireAt,
            created_at: Date.now(),
            fired: false,
            recurring: r.recurring,
          };
          store.reminders.push(next);
          scheduleTimer(config, next);
        }
      }

      saveStore(config, store);
    }
  }, delay);
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  // Fire any past-due reminders on load
  fireDueReminders(config).catch(() => {});

  // Schedule in-process timers for pending reminders within 24h
  try {
    const store = loadStore(config);
    for (const r of store.reminders) {
      if (!r.fired) scheduleTimer(config, r);
    }
  } catch {}

  return [
    {
      name: 'reminder_set',
      description:
        'Set a timed reminder. The user will receive a Telegram message when it fires. ' +
        'Convert natural language times to ISO datetime before calling (e.g. "in 30 minutes" → compute the actual datetime).',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'What to remind the user about',
          },
          fire_at: {
            type: 'string',
            description: 'When to fire the reminder, ISO 8601 datetime (e.g. "2025-03-15T14:30:00")',
          },
          recurring: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Optional: make this a recurring reminder',
          },
        },
        required: ['message', 'fire_at'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          // Fire any past-due first
          await fireDueReminders(config);

          const message = input.message as string;
          const fireAt = new Date(input.fire_at as string).getTime();
          const recurring = input.recurring as string | undefined;

          if (isNaN(fireAt)) {
            return JSON.stringify({ success: false, error: 'Invalid datetime format. Use ISO 8601.' });
          }

          if (fireAt <= Date.now()) {
            return JSON.stringify({ success: false, error: 'Cannot set a reminder in the past.' });
          }

          const reminder: Reminder = {
            id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            message,
            fire_at: fireAt,
            created_at: Date.now(),
            fired: false,
            recurring,
          };

          const store = loadStore(config);
          store.reminders.push(reminder);
          saveStore(config, store);

          // Schedule in-process timer
          scheduleTimer(config, reminder);

          const fireDate = new Date(fireAt);
          return JSON.stringify({
            success: true,
            id: reminder.id,
            message,
            fire_at: fireDate.toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' }),
            recurring: recurring || null,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'reminder_list',
      description: 'List all pending (unfired) reminders.',
      inputSchema: {
        type: 'object',
        properties: {
          include_fired: {
            type: 'boolean',
            description: 'Also show already-fired reminders. Default: false.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          await fireDueReminders(config);

          const store = loadStore(config);
          const includeFired = input.include_fired === true;
          const reminders = store.reminders
            .filter(r => includeFired || !r.fired)
            .map(r => ({
              id: r.id,
              message: r.message,
              fire_at: new Date(r.fire_at).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' }),
              fired: r.fired,
              recurring: r.recurring || null,
            }));

          return JSON.stringify({
            success: true,
            count: reminders.length,
            reminders,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'reminder_cancel',
      description: 'Cancel a pending reminder by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The reminder ID to cancel',
          },
        },
        required: ['id'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const idx = store.reminders.findIndex(r => r.id === input.id);

          if (idx === -1) {
            return JSON.stringify({ success: false, error: 'Reminder not found.' });
          }

          const removed = store.reminders.splice(idx, 1)[0];
          saveStore(config, store);

          return JSON.stringify({
            success: true,
            cancelled: {
              id: removed.id,
              message: removed.message,
            },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
