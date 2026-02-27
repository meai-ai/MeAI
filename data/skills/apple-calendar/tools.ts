/**
 * Apple Calendar skill via iCloud CalDAV.
 *
 * iCloud CalDAV paths use a numeric user ID, NOT the email address.
 * We must discover the correct path via a two-step PROPFIND before querying events.
 *
 * Discovery flow:
 *   1. PROPFIND https://caldav.icloud.com/ → get <current-user-principal> href
 *   2. PROPFIND <principal-href> → get <calendar-home-set> href
 *   3. REPORT <calendar-home-set-href> → list events
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

const ICLOUD_BASE = 'https://caldav.icloud.com';

interface CalDAVConfig {
  appleId: string;
  appPassword: string;
  calendarUrl?: string; // optional override — skip discovery if set
}

interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function makeRequest(
  url: string,
  method: string,
  auth: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/xml; charset=utf-8',
        ...extraHeaders,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── XML helpers ──────────────────────────────────────────────────────────────

/** Extract the text content of the first matching XML tag (handles namespaced tags). */
function extractXmlHref(xml: string, tag: string): string | null {
  // Match <tag ...> <href>value</href> — handles whitespace and namespaces
  const tagRegex = new RegExp(`<[^>]*${tag}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<`, 'i');
  const m = xml.match(tagRegex);
  return m ? m[1].trim() : null;
}

// ── CalDAV discovery ─────────────────────────────────────────────────────────

/**
 * Discover the iCloud calendar-home-set path for this account.
 * Returns an absolute URL like https://p01-caldav.icloud.com/1234567890/calendars/
 */
async function discoverCalendarHome(config: CalDAVConfig): Promise<string> {
  // If the user has configured an explicit URL, use it directly.
  if (config.calendarUrl) return config.calendarUrl;

  const auth = Buffer.from(`${config.appleId}:${config.appPassword}`).toString('base64');

  // Step 1: find current-user-principal
  const step1Body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;

  const step1 = await makeRequest(ICLOUD_BASE + '/', 'PROPFIND', auth, step1Body, { Depth: '0' });

  // iCloud often redirects — check Location header
  let principalHref = extractXmlHref(step1.body, 'current-user-principal');
  if (!principalHref) {
    throw new Error(
      `CalDAV discovery step 1 failed (HTTP ${step1.status}). ` +
      `Check Apple ID and app-specific password. Response: ${step1.body.slice(0, 300)}`
    );
  }

  // Resolve to absolute URL
  const principalUrl = principalHref.startsWith('http')
    ? principalHref
    : ICLOUD_BASE + principalHref;

  // Step 2: find calendar-home-set
  const step2Body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

  const step2 = await makeRequest(principalUrl, 'PROPFIND', auth, step2Body, { Depth: '0' });

  const calHomeHref = extractXmlHref(step2.body, 'calendar-home-set');
  if (!calHomeHref) {
    throw new Error(
      `CalDAV discovery step 2 failed (HTTP ${step2.status}). ` +
      `Response: ${step2.body.slice(0, 300)}`
    );
  }

  return calHomeHref.startsWith('http') ? calHomeHref : ICLOUD_BASE + calHomeHref;
}

// ── iCal helpers ─────────────────────────────────────────────────────────────

function parseICalDate(dateStr: string): Date {
  if (dateStr.includes('T')) {
    const year = parseInt(dateStr.slice(0, 4));
    const month = parseInt(dateStr.slice(4, 6)) - 1;
    const day = parseInt(dateStr.slice(6, 8));
    const hour = parseInt(dateStr.slice(9, 11));
    const minute = parseInt(dateStr.slice(11, 13));
    const second = parseInt(dateStr.slice(13, 15));
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  } else {
    const year = parseInt(dateStr.slice(0, 4));
    const month = parseInt(dateStr.slice(4, 6)) - 1;
    const day = parseInt(dateStr.slice(6, 8));
    return new Date(year, month, day);
  }
}

function formatICalDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function parseVEvent(vevent: string): CalendarEvent | null {
  // Unfold iCal line continuations (lines starting with space/tab)
  const unfolded = vevent.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const event: Partial<CalendarEvent> = {};

  for (const line of lines) {
    if (line.startsWith('UID:')) event.uid = line.slice(4);
    else if (line.startsWith('SUMMARY:')) event.summary = line.slice(8);
    else if (line.startsWith('DESCRIPTION:')) event.description = line.slice(12);
    else if (line.startsWith('DTSTART')) { const m = line.match(/DTSTART[^:]*:(.*)/); if (m) event.start = m[1]; }
    else if (line.startsWith('DTEND')) { const m = line.match(/DTEND[^:]*:(.*)/); if (m) event.end = m[1]; }
    else if (line.startsWith('LOCATION:')) event.location = line.slice(9);
  }

  if (event.uid && event.summary && event.start && event.end) return event as CalendarEvent;
  return null;
}

// ── Tool exports ─────────────────────────────────────────────────────────────

export function getTools(config: any): any[] {
  const calConfig = config.tools?.['apple-calendar'] as CalDAVConfig | undefined;

  if (!calConfig?.appleId || !calConfig?.appPassword) {
    return [{
      name: 'calendar_setup_required',
      description: 'Apple Calendar requires configuration.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => JSON.stringify({
        error: 'Setup required',
        instructions: [
          '1. Go to https://appleid.apple.com → Security → App-Specific Passwords',
          '2. Generate a password for MeAI',
          '3. Add to config.json: tools["apple-calendar"].appleId and .appPassword',
        ],
      }),
    }];
  }

  return [
    {
      name: 'calendar_list_events',
      description: 'List events from Apple Calendar (iCloud). Use to check schedule, upcoming meetings, or any date range.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'this_week', 'next_week', 'this_month'],
            description: 'Convenience shortcut. Overrides start_date/end_date.',
          },
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD. Defaults to today.' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD. Defaults to 7 days from start.' },
        },
        required: [],
      },
      execute: async (args: any): Promise<string> => {
        const now = new Date();
        let startDate: Date;
        let endDate: Date;

        if (args.period) {
          switch (args.period) {
            case 'today':
              startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
              break;
            case 'this_week': {
              const diff = now.getDay() === 0 ? -6 : 1 - now.getDay();
              startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
              endDate = new Date(startDate.getTime() + 7 * 86400000);
              break;
            }
            case 'next_week': {
              const diff = now.getDay() === 0 ? 1 : 8 - now.getDay();
              startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
              endDate = new Date(startDate.getTime() + 7 * 86400000);
              break;
            }
            case 'this_month':
              startDate = new Date(now.getFullYear(), now.getMonth(), 1);
              endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
              break;
            default:
              startDate = now;
              endDate = new Date(now.getTime() + 7 * 86400000);
          }
        } else {
          startDate = args.start_date ? new Date(args.start_date) : now;
          endDate = args.end_date ? new Date(args.end_date) : new Date(startDate.getTime() + 7 * 86400000);
        }

        try {
          // Discover the real calendar-home-set URL (iCloud uses numeric user IDs)
          const calHomeUrl = await discoverCalendarHome(calConfig);
          const auth = Buffer.from(`${calConfig.appleId}:${calConfig.appPassword}`).toString('base64');

          const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatICalDate(startDate)}" end="${formatICalDate(endDate)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

          const res = await makeRequest(calHomeUrl, 'REPORT', auth, reportBody, { Depth: '1' });

          const events: CalendarEvent[] = [];
          const vevents = res.body.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
          for (const v of vevents) {
            const e = parseVEvent(v);
            if (e) events.push(e);
          }

          events.sort((a, b) => a.start.localeCompare(b.start));

          return JSON.stringify({
            success: true,
            count: events.length,
            range: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
            events: events.map(e => ({
              summary: e.summary,
              start: parseICalDate(e.start).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' }),
              end: parseICalDate(e.end).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' }),
              location: e.location || null,
              description: e.description || null,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'calendar_add_event',
      description: 'Add a new event to Apple Calendar (iCloud).',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start datetime ISO format (YYYY-MM-DDTHH:MM:SS)' },
          end: { type: 'string', description: 'End datetime ISO format (YYYY-MM-DDTHH:MM:SS)' },
          description: { type: 'string', description: 'Optional description' },
          location: { type: 'string', description: 'Optional location' },
        },
        required: ['summary', 'start', 'end'],
      },
      execute: async (args: any): Promise<string> => {
        try {
          const calHomeUrl = await discoverCalendarHome(calConfig);
          const auth = Buffer.from(`${calConfig.appleId}:${calConfig.appPassword}`).toString('base64');

          const uid = `${Date.now()}@meai`;
          const startDate = new Date(args.start);
          const endDate = new Date(args.end);
          const now = new Date();

          const optLines: string[] = [];
          if (args.description) optLines.push(`DESCRIPTION:${args.description}`);
          if (args.location) optLines.push(`LOCATION:${args.location}`);

          const ical = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//MeAI//Calendar//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${formatICalDate(now)}`,
            `DTSTART:${formatICalDate(startDate)}`,
            `DTEND:${formatICalDate(endDate)}`,
            `SUMMARY:${args.summary}`,
            ...optLines,
            'END:VEVENT',
            'END:VCALENDAR',
          ].join('\r\n');

          const eventUrl = calHomeUrl.replace(/\/$/, '') + `/${uid}.ics`;
          const res = await makeRequest(eventUrl, 'PUT', auth, ical, {
            'Content-Type': 'text/calendar; charset=utf-8',
          });

          if (res.status === 201 || res.status === 204) {
            return JSON.stringify({
              success: true,
              message: '已添加到日历',
              event: { summary: args.summary, start: args.start, end: args.end },
            });
          } else {
            return JSON.stringify({ success: false, status: res.status, body: res.body.slice(0, 500) });
          }
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
