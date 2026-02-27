/**
 * Phone call skill — make AI-powered outbound calls via Bland.ai.
 * Used for booking appointments, reservations, and business calls.
 *
 * Requires: bland.api_key stored in MeAI memory.
 * Cost: ~$0.09/min per call.
 */

import * as https from 'https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Memory reader ───────────────────────────────────────────────────────────

function getMemoryValue(config: any, key: string): string | null {
  try {
    const statePath = config?.statePath || 'data';
    const storePath = join(statePath, 'memory', 'store.json');
    if (!existsSync(storePath)) return null;
    const store = JSON.parse(readFileSync(storePath, 'utf-8'));
    const mem = store.memories?.find((m: any) => m.key === key);
    return mem?.value || null;
  } catch {
    return null;
  }
}

// ── Call history ────────────────────────────────────────────────────────────

interface CallRecord {
  call_id: string;
  phone_number: string;
  task: string;
  venue_name?: string;
  timestamp: number;
  status: 'initiated' | 'completed' | 'failed';
  transcript?: string;
  summary?: string;
  duration?: number;
  cost?: number;
}

function getHistoryPath(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'phone-call');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'call-history.json');
}

function loadHistory(config: any): CallRecord[] {
  const path = getHistoryPath(config);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(config: any, history: CallRecord[]): void {
  writeFileSync(getHistoryPath(config), JSON.stringify(history, null, 2));
}

// ── Bland.ai API ────────────────────────────────────────────────────────────

function blandRequest(method: string, path: string, apiKey: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined;

    const options: https.RequestOptions = {
      hostname: 'api.bland.ai',
      port: 443,
      path,
      method,
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('API request timeout')); });

    if (postData) req.write(postData);
    req.end();
  });
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'phone_call_make',
      description:
        'Make an AI-powered phone call. The AI agent handles the full conversation ' +
        'based on the task description. Use for booking appointments, making reservations, ' +
        'calling businesses, etc. ' +
        'IMPORTANT: Always confirm with the user before making a call. ' +
        'Returns a call_id — use phone_call_status to get the result after 2-3 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'Phone number in E.164 format (e.g. "+12065551234"). Include country code.',
          },
          task: {
            type: 'string',
            description:
              'Detailed description of what the AI should do on the call. ' +
              'Include: purpose, name to give, date/time preferences, specific questions to ask, ' +
              'and any constraints. Example: "Call to book a tennis court on Saturday ' +
              'March 1st at 10am. Preferred outdoor court. Ask about cancellation policy."',
          },
          venue_name: {
            type: 'string',
            description: 'Name of the business being called (for record-keeping).',
          },
          first_sentence: {
            type: 'string',
            description: 'Optional opening sentence. Default: derived from task.',
          },
          max_duration: {
            type: 'number',
            description: 'Max call duration in minutes. Default: 5.',
          },
          voice: {
            type: 'string',
            description: 'Voice to use. Options: "mason", "maya", "ryan", "adriana". Default: "mason".',
          },
          language: {
            type: 'string',
            description: 'Language code (e.g. "en", "zh"). Default: "en".',
          },
        },
        required: ['phone_number', 'task'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const apiKey = getMemoryValue(config, 'bland.api_key');
          if (!apiKey) {
            return JSON.stringify({
              success: false,
              error: 'Bland.ai API key not configured.',
              setup: 'Use memory_set to store bland.api_key. Get your key at app.bland.ai (free tier available).',
            });
          }

          const phoneNumber = input.phone_number as string;
          const task = input.task as string;
          const venueName = (input.venue_name as string) || '';
          const maxDuration = (input.max_duration as number) || 5;

          // Validate phone number format
          if (!phoneNumber.match(/^\+\d{10,15}$/)) {
            return JSON.stringify({
              success: false,
              error: 'Invalid phone number format. Use E.164 format: +12065551234',
            });
          }

          // Make the call
          const result = await blandRequest('POST', '/v1/calls', apiKey, {
            phone_number: phoneNumber,
            task,
            voice: (input.voice as string) || 'mason',
            language: (input.language as string) || 'en',
            model: 'base',
            max_duration: maxDuration,
            record: true,
            wait_for_greeting: true,
            first_sentence: (input.first_sentence as string) || undefined,
          });

          if (result.status === 'success' && result.call_id) {
            // Save to history
            const history = loadHistory(config);
            history.push({
              call_id: result.call_id,
              phone_number: phoneNumber,
              task,
              venue_name: venueName,
              timestamp: Date.now(),
              status: 'initiated',
            });
            saveHistory(config, history);

            return JSON.stringify({
              success: true,
              call_id: result.call_id,
              phone_number: phoneNumber,
              venue_name: venueName || null,
              message: 'Call initiated. The AI is now on the phone. Use phone_call_status with the call_id in 2-3 minutes to get the transcript and result.',
            });
          }

          return JSON.stringify({
            success: false,
            error: result.message || result.error || 'Failed to initiate call',
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'phone_call_status',
      description:
        'Check the status and get the transcript of a phone call. ' +
        'Call this after phone_call_make — typically wait 2-3 minutes for the call to complete. ' +
        'Returns: transcript, summary, duration, cost, and whether the call was answered.',
      inputSchema: {
        type: 'object',
        properties: {
          call_id: {
            type: 'string',
            description: 'The call_id returned from phone_call_make.',
          },
        },
        required: ['call_id'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const apiKey = getMemoryValue(config, 'bland.api_key');
          if (!apiKey) {
            return JSON.stringify({ success: false, error: 'Bland.ai API key not configured.' });
          }

          const callId = input.call_id as string;
          const result = await blandRequest('GET', `/v1/calls/${callId}`, apiKey);

          if (result.error) {
            return JSON.stringify({ success: false, error: result.error });
          }

          // Update history
          const history = loadHistory(config);
          const record = history.find(h => h.call_id === callId);
          if (record) {
            record.status = result.completed ? 'completed' : 'initiated';
            record.transcript = result.concatenated_transcript || '';
            record.summary = result.summary || '';
            record.duration = result.call_length;
            record.cost = result.price;
            saveHistory(config, history);
          }

          // Format transcript for readability
          const transcripts = result.transcripts as Array<{ text: string; user: string }> | undefined;
          let formattedTranscript = '';
          if (transcripts && Array.isArray(transcripts)) {
            formattedTranscript = transcripts
              .map((t: any) => `${t.user === 'assistant' ? 'AI' : 'Them'}: ${t.text}`)
              .join('\n');
          }

          return JSON.stringify({
            success: true,
            completed: result.completed || false,
            answered_by: result.answered_by || 'unknown',
            call_length_minutes: result.call_length
              ? Math.round(result.call_length * 100) / 100
              : null,
            cost: result.price ? `$${result.price}` : null,
            summary: result.summary || null,
            transcript: formattedTranscript || result.concatenated_transcript || 'No transcript available yet.',
            recording_url: result.recording_url || null,
            status: result.completed ? 'completed' : 'in_progress',
            tip: result.completed
              ? null
              : 'Call still in progress. Try again in 1-2 minutes.',
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'phone_call_history',
      description:
        'View recent call history. Shows past calls with their status, venue, and outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max entries to return. Default: 10.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const limit = (input.limit as number) || 10;
          const history = loadHistory(config);

          const recent = history.slice(-limit).reverse().map(h => ({
            call_id: h.call_id,
            phone_number: h.phone_number,
            venue: h.venue_name || null,
            task: h.task.slice(0, 100) + (h.task.length > 100 ? '...' : ''),
            status: h.status,
            date: new Date(h.timestamp).toLocaleString('en-US', {
              timeZone: 'America/Los_Angeles',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
            duration: h.duration ? `${Math.round(h.duration * 100) / 100} min` : null,
            cost: h.cost ? `$${h.cost}` : null,
            summary: h.summary || null,
          }));

          return JSON.stringify({
            success: true,
            count: recent.length,
            total_calls: history.length,
            calls: recent,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
