/**
 * News digest skill — fetch and parse RSS feeds for tech, general, and finance news.
 * No API key required.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// ── Feed configuration ──────────────────────────────────────────────────────

interface FeedConfig {
  name: string;
  url: string;
  category: string;
}

const FEEDS: FeedConfig[] = [
  // Tech
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', category: 'tech' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },

  // General
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'general' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', category: 'general' },

  // Finance
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: 'finance' },
];

// ── HTTP helper ─────────────────────────────────────────────────────────────

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      headers: {
        'User-Agent': 'MeAI/1.0 RSS Reader',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── RSS parsing ─────────────────────────────────────────────────────────────

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  source: string;
}

function parseRSS(xml: string, source: string): FeedItem[] {
  const items: FeedItem[] = [];

  // Match <item> blocks
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];

  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractGuidTag(block);
    const description = cleanHtml(extractTag(block, 'description') || '');
    const pubDate = extractTag(block, 'pubDate') || '';

    if (title && link) {
      items.push({
        title: cleanHtml(title),
        link,
        description: description.slice(0, 200),
        pubDate,
        source,
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Regular tag
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractGuidTag(xml: string): string | null {
  const match = xml.match(/<guid[^>]*>([^<]+)<\/guid>/i);
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
    .trim();
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'news_fetch',
      description:
        'Fetch latest news headlines from RSS feeds. ' +
        'Categories: tech, general, finance, or all. ' +
        'Use for morning briefings, news checks, or topic-specific news.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['tech', 'general', 'finance', 'all'],
            description: 'News category to fetch. Default: all.',
          },
          max_items: {
            type: 'number',
            description: 'Max headlines per feed. Default: 5.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const category = (input.category as string) || 'all';
          const maxItems = (input.max_items as number) || 5;

          const feeds = category === 'all'
            ? FEEDS
            : FEEDS.filter(f => f.category === category);

          const results: Record<string, FeedItem[]> = {};

          // Fetch all feeds in parallel
          const promises = feeds.map(async (feed) => {
            try {
              const xml = await fetchUrl(feed.url);
              const items = parseRSS(xml, feed.name).slice(0, maxItems);
              return { category: feed.category, source: feed.name, items };
            } catch {
              return { category: feed.category, source: feed.name, items: [] };
            }
          });

          const feedResults = await Promise.all(promises);

          for (const result of feedResults) {
            if (!results[result.category]) results[result.category] = [];
            results[result.category].push(...result.items);
          }

          // Count total items
          const totalItems = Object.values(results).reduce((sum, items) => sum + items.length, 0);

          return JSON.stringify({
            success: true,
            total_items: totalItems,
            categories: Object.fromEntries(
              Object.entries(results).map(([cat, items]) => [
                cat,
                items.map(i => ({
                  title: i.title,
                  link: i.link,
                  source: i.source,
                  description: i.description,
                })),
              ]),
            ),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
