/**
 * Shared web search module — Tavily API with DuckDuckGo fallback.
 *
 * Used by both the curiosity engine (background exploration) and the
 * user-facing web_search/web_fetch skill tools.
 *
 * If `tavilyApiKey` is configured → uses Tavily (stable REST API, AI-ranked results).
 * Otherwise → falls back to DuckDuckGo HTML scraping (no API key needed).
 */

import * as https from "https";
import * as http from "http";
import { URL } from "url";
import type { AppConfig } from "../types.js";
import { createLogger } from "./logger.js";

const log = createLogger("search");

// ── Types ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full page content in markdown (Tavily only, when includeRawContent is true) */
  rawContent?: string;
  /** Relevance score 0-1 (Tavily only) */
  score?: number;
}

export interface SearchOptions {
  /** Include full page content in results (default: false). Tavily only. */
  includeRawContent?: boolean;
  /** Topic hint for search ranking */
  topic?: "general" | "news" | "finance";
  /** Search depth — "basic" = 1 credit, "advanced" = 2 credits */
  searchDepth?: "basic" | "advanced";
}

// ── Module state ─────────────────────────────────────────────────────

let tavilyApiKey: string | undefined;

export function initSearch(config: AppConfig): void {
  tavilyApiKey = config.tavilyApiKey;
  if (tavilyApiKey) {
    log.info("Tavily API configured — using Tavily for web search");
  } else {
    log.info("No Tavily API key — falling back to DuckDuckGo");
  }
}

// ── SSRF protection ──────────────────────────────────────────────────

function isInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    if (hostname === "169.254.169.254") return true;
    return false;
  } catch {
    return true; // block unparseable URLs
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────

function httpGet(
  url: string,
  headers: Record<string, string> = {},
  maxRedirects = 3,
): Promise<string> {
  if (isInternalUrl(url)) {
    return Promise.reject(new Error(`Blocked internal URL: ${url}`));
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MeAI/1.0)",
          Accept: "text/html,application/xhtml+xml,application/json",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (maxRedirects <= 0) { reject(new Error("Too many redirects")); return; }
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
          httpGet(redirectUrl, headers, maxRedirects - 1).then(resolve, reject);
          return;
        }
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(data));
      },
    );

    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Tavily search ────────────────────────────────────────────────────

async function searchTavily(
  query: string,
  maxResults: number,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const body = JSON.stringify({
    query,
    max_results: maxResults,
    search_depth: options.searchDepth ?? "basic",
    include_raw_content: options.includeRawContent ? "markdown" : false,
    include_answer: false,
    topic: options.topic ?? "general",
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.tavily.com",
        path: "/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tavilyApiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Tavily API error ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            const json = JSON.parse(data);
            const results: SearchResult[] = (json.results ?? []).map((r: any) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
              rawContent: r.raw_content || undefined,
              score: r.score,
            }));
            resolve(results);
          } catch (err) {
            reject(new Error(`Failed to parse Tavily response: ${err}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Tavily timeout")); });
    req.write(body);
    req.end();
  });
}

// ── DuckDuckGo search (fallback) ─────────────────────────────────────

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const html = await httpGet(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { "Content-Type": "application/x-www-form-urlencoded" },
  );

  const results: SearchResult[] = [];
  const resultBlocks = html.match(/<a class="result__a"[\s\S]*?<\/a>[\s\S]*?class="result__snippet"[\s\S]*?<\/a>/g) || [];

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

  // Fallback: simpler regex
  if (results.length === 0) {
    const linkMatches = html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g);
    for (const m of linkMatches) {
      if (results.length >= maxResults) break;
      let url = m[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
      const title = htmlToText(m[2]).trim();
      if (url && title) results.push({ title, url, snippet: "" });
    }
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Search the web. Uses Tavily if API key is configured, otherwise DuckDuckGo.
 */
export async function searchWeb(
  query: string,
  maxResults = 5,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  if (tavilyApiKey) {
    try {
      log.info(`Using Tavily: "${query}" (max ${maxResults})`);
      return await searchTavily(query, maxResults, options);
    } catch (err) {
      log.warn("Tavily search failed, falling back to DuckDuckGo", err);
      // Fall through to DuckDuckGo
    }
  }

  log.info(`Using DuckDuckGo: "${query}" (max ${maxResults})`);
  return searchDuckDuckGo(query, maxResults);
}

/**
 * Fetch and extract text content from a URL.
 * Used for reading pages that weren't covered by search rawContent.
 */
export async function fetchPage(url: string, maxChars = 3000): Promise<string> {
  try {
    const html = await httpGet(url);
    let text = htmlToText(html);
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return text;
  } catch (err) {
    log.warn(`failed to fetch page: ${url}`, err);
    return "";
  }
}
