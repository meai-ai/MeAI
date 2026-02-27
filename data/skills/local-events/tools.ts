/**
 * Local events skill — discover local events and activities.
 * Aggregates from multiple free sources (RSS, public web pages).
 * No API key required.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// ── Types ───────────────────────────────────────────────────────────────────

interface LocalEvent {
  title: string;
  date: string;
  location: string;
  description: string;
  link: string;
  source: string;
  category: string;
}

type EventCategory = 'family' | 'tech' | 'outdoors' | 'arts' | 'food' | 'all';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function fetchUrl(url: string, maxRedirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeAI/1.0)',
        Accept: 'text/html,application/rss+xml,application/xml,text/xml,application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        fetchUrl(redirectUrl, maxRedirects - 1).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── XML/HTML parsing helpers ────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string | null {
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Event source: DuckDuckGo event search ───────────────────────────────────

async function searchEvents(query: string, maxResults: number): Promise<LocalEvent[]> {
  try {
    const html = await fetchUrl(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );

    const events: LocalEvent[] = [];
    const resultBlocks = html.match(/<a class="result__a"[\s\S]*?<\/a>[\s\S]*?class="result__snippet"[\s\S]*?<\/a>/g) || [];

    for (const block of resultBlocks) {
      if (events.length >= maxResults) break;

      const hrefMatch = block.match(/href="([^"]+)"/);
      let url = hrefMatch ? hrefMatch[1] : '';
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

      const titleMatch = block.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? cleanHtml(titleMatch[1]) : '';

      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : '';

      if (title && url) {
        events.push({
          title,
          date: '',
          location: 'local area',
          description: snippet.slice(0, 200),
          link: url,
          source: 'web',
          category: 'all',
        });
      }
    }

    return events;
  } catch {
    return [];
  }
}

// ── Event source: RSS feeds ─────────────────────────────────────────────────

interface EventFeed {
  name: string;
  url: string;
  category: string;
}

const EVENT_FEEDS: EventFeed[] = [
  // Example event/community RSS feeds — replace with feeds for your city
  // {
  //   name: 'Local News Events',
  //   url: 'https://example.com/events/rss/',
  //   category: 'arts',
  // },
];

async function fetchRSSEvents(feed: EventFeed, maxItems: number): Promise<LocalEvent[]> {
  try {
    const xml = await fetchUrl(feed.url);
    const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
    const events: LocalEvent[] = [];

    for (const item of items) {
      if (events.length >= maxItems) break;

      const title = cleanHtml(extractTag(item, 'title') || '');
      const link = extractTag(item, 'link') || '';
      const description = cleanHtml(extractTag(item, 'description') || '').slice(0, 200);
      const pubDate = extractTag(item, 'pubDate') || '';

      if (title) {
        events.push({
          title,
          date: pubDate,
          location: 'local area',
          description,
          link,
          source: feed.name,
          category: feed.category,
        });
      }
    }

    return events;
  } catch {
    return [];
  }
}

// ── Search query builders ───────────────────────────────────────────────────

function buildSearchQuery(category: EventCategory, timeframe: string, city: string): string {
  const base = `${city} events ${timeframe}`;

  switch (category) {
    case 'family':
      return `${base} kids family friendly activities`;
    case 'tech':
      return `${base} tech meetup developer`;
    case 'outdoors':
      return `${base} outdoor hiking nature`;
    case 'arts':
      return `${base} art museum theater concert`;
    case 'food':
      return `${base} food festival farmers market restaurant`;
    default:
      return `${base} things to do`;
  }
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'events_search',
      description:
        'Search for local events and activities in a city. ' +
        'Combines web search and RSS feeds to find current events. ' +
        'Categories: family, tech, outdoors, arts, food, or all. ' +
        'Use for "what\'s happening this weekend?", "kid-friendly events", "tech meetups", etc.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['family', 'tech', 'outdoors', 'arts', 'food', 'all'],
            description: 'Event category. Default: all.',
          },
          timeframe: {
            type: 'string',
            enum: ['today', 'this weekend', 'this week', 'this month'],
            description: 'When to look for events. Default: this weekend.',
          },
          city: {
            type: 'string',
            description: 'City to search in. Default: from character config.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum results. Default: 10.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const category = (input.category as EventCategory) || 'all';
          const timeframe = (input.timeframe as string) || 'this weekend';
          const city = (input.city as string) || 'New York';
          const maxResults = (input.max_results as number) || 10;

          const allEvents: LocalEvent[] = [];

          // 1. Web search for events
          const query = buildSearchQuery(category, timeframe, city);
          const searchResults = await searchEvents(query, Math.ceil(maxResults * 0.7));
          allEvents.push(...searchResults);

          // 2. RSS feeds (for family and arts categories, or all)
          if (category === 'all' || category === 'family' || category === 'arts') {
            const feedPromises = EVENT_FEEDS
              .filter(f => category === 'all' || f.category === category)
              .map(f => fetchRSSEvents(f, 5));

            const feedResults = await Promise.all(feedPromises);
            for (const events of feedResults) {
              allEvents.push(...events);
            }
          }

          // Deduplicate by title similarity
          const seen = new Set<string>();
          const unique = allEvents.filter(e => {
            const key = e.title.toLowerCase().slice(0, 40);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, maxResults);

          return JSON.stringify({
            success: true,
            query: { category, timeframe, city },
            count: unique.length,
            events: unique.map(e => ({
              title: e.title,
              date: e.date || null,
              location: e.location,
              description: e.description,
              link: e.link,
              source: e.source,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'events_family',
      description:
        'Shortcut to find family-friendly and kid activities. ' +
        'Use for "what can we do with the kids?", "family weekend plans".',
      inputSchema: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['today', 'this weekend', 'this week', 'this month'],
            description: 'Default: this weekend.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const timeframe = (input.timeframe as string) || 'this weekend';

          const allEvents: LocalEvent[] = [];

          // Search for age-appropriate activities
          const queries = [
            `${timeframe} kids activities family friendly`,
            `${timeframe} family events children`,
          ];

          for (const q of queries) {
            const results = await searchEvents(q, 5);
            allEvents.push(...results);
          }

          // RSS family feeds
          const familyFeeds = EVENT_FEEDS.filter(f => f.category === 'family');
          for (const feed of familyFeeds) {
            const events = await fetchRSSEvents(feed, 5);
            allEvents.push(...events);
          }

          // Deduplicate
          const seen = new Set<string>();
          const unique = allEvents.filter(e => {
            const key = e.title.toLowerCase().slice(0, 40);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 10);

          return JSON.stringify({
            success: true,
            timeframe,
            count: unique.length,
            events: unique.map(e => ({
              title: e.title,
              date: e.date || null,
              location: e.location,
              description: e.description,
              link: e.link,
              source: e.source,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
