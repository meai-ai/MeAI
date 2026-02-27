/**
 * DuckDuckGo search sense provider.
 *
 * Extracted from src/lib/search.ts. No API key needed —
 * scrapes DuckDuckGo HTML search results.
 */

import * as https from "https";
import * as http from "http";
import { URL } from "url";
import type { AppConfig } from "../../types.js";
import type { SenseProvider, SenseType, SearchResult } from "../types.js";

function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MeAI/1.0)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        httpGet(redirectUrl, headers).then(resolve, reject);
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

const provider: SenseProvider = {
  id: "search-duckduckgo",
  type: "search" as SenseType,
  name: "DuckDuckGo Web Search (free)",

  isAvailable(): boolean {
    return true; // No API key needed
  },

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const html = await httpGet(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { "Content-Type": "application/x-www-form-urlencoded" },
    );

    const results: SearchResult[] = [];
    const resultBlocks = html.match(
      /<a class="result__a"[\s\S]*?<\/a>[\s\S]*?class="result__snippet"[\s\S]*?<\/a>/g,
    ) || [];

    for (const block of resultBlocks) {
      if (results.length >= maxResults) break;

      const hrefMatch = block.match(/href="([^"]+)"/);
      let url = hrefMatch ? hrefMatch[1] : "";
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

      const titleMatch = block.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? htmlToText(titleMatch[1]).trim() : "";

      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]).trim() : "";

      if (url && title) results.push({ title, url, snippet });
    }

    return results;
  },
};

export default provider;
