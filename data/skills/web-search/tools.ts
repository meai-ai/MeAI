/**
 * Web search skill — search the web and fetch page content.
 * Uses shared search module (Tavily API with DuckDuckGo fallback).
 */

import { searchWeb, fetchPage } from '../../../src/lib/search.js';

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'web_search',
      description:
        'Search the web. Returns titles, URLs, and snippets. ' +
        'Use for any question requiring current information, facts you\'re unsure about, ' +
        'or looking up documentation/events/prices.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (like you\'d type into Google)',
          },
          max_results: {
            type: 'number',
            description: 'Maximum results to return. Default: 8.',
          },
        },
        required: ['query'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const query = input.query as string;
          const maxResults = (input.max_results as number) || 8;

          const results = await searchWeb(query, maxResults);

          if (results.length === 0) {
            return JSON.stringify({
              success: true,
              query,
              count: 0,
              results: [],
              note: 'No results found. Try rephrasing the query.',
            });
          }

          // Strip rawContent from user-facing results to keep response small
          const cleanResults = results.map(({ rawContent, ...r }) => r);

          return JSON.stringify({
            success: true,
            query,
            count: cleanResults.length,
            results: cleanResults,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'web_fetch',
      description:
        'Fetch and extract text content from a specific URL. ' +
        'Use after web_search to read a page in detail, or to fetch any known URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (https://...)',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters to return. Default: 5000.',
          },
        },
        required: ['url'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const url = input.url as string;
          const maxChars = (input.max_chars as number) || 5000;

          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return JSON.stringify({ success: false, error: 'URL must start with http:// or https://' });
          }

          const text = await fetchPage(url, maxChars);
          const truncated = text.length >= maxChars;

          return JSON.stringify({
            success: true,
            url,
            truncated,
            content: truncated ? text + '\n\n[...truncated]' : text,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
